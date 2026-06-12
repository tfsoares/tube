package proxy

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"
)

// CertPaths holds filesystem paths to TLS material.
type CertPaths struct {
	CAKey  string
	CACert string
	SrvKey string
	SrvCert string
	Srl    string
	HostDir string
}

func certDir() string {
	home, _ := os.UserHomeDir()
	dir := os.Getenv("TUBE_STATE_DIR")
	if dir == "" {
		dir = filepath.Join(home, ".tube", "ca")
	}
	return dir
}

func DefaultCertPaths() CertPaths {
	ca := certDir()
	return CertPaths{
		CAKey:  filepath.Join(ca, "ca-key.pem"),
		CACert: filepath.Join(ca, "ca.pem"),
		SrvKey: filepath.Join(ca, "server-key.pem"),
		SrvCert: filepath.Join(ca, "server.pem"),
		Srl:    filepath.Join(ca, "ca.srl"),
		HostDir: filepath.Join(ca, "host-certs"),
	}
}

// LoadOrGenerateCerts loads existing TLS certs or generates new ones.
// Returns the server TLS certificate and the CA certificate pool.
func LoadOrGenerateCerts(tld string, paths CertPaths) (*tls.Certificate, *x509.CertPool, error) {
	os.MkdirAll(filepath.Dir(paths.CACert), 0700)

	// Ensure CA exists
	if !fileExists(paths.CACert) || !fileExists(paths.CAKey) {
		if err := generateCA(paths); err != nil {
			return nil, nil, fmt.Errorf("generate CA: %w", err)
		}
	}

	// Load CA for cert pool
	caPEM, err := os.ReadFile(paths.CACert)
	if err != nil {
		return nil, nil, err
	}
	caPool := x509.NewCertPool()
	caPool.AppendCertsFromPEM(caPEM)

	// Ensure server cert exists
	if !fileExists(paths.SrvCert) || !fileExists(paths.SrvKey) {
		if err := generateServerCert(tld, paths); err != nil {
			return nil, nil, fmt.Errorf("generate server cert: %w", err)
		}
	}

	// Load server cert
	cert, err := tls.LoadX509KeyPair(paths.SrvCert, paths.SrvKey)
	if err != nil {
		return nil, nil, err
	}

	return &cert, caPool, nil
}

// SNICallback returns a function that provides per-hostname TLS certificates.
func SNICallback(tld string, paths CertPaths, caCert *tls.Certificate) func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	os.MkdirAll(paths.HostDir, 0700)

	return func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		hostname := hello.ServerName
		if hostname == "" {
			return nil, nil
		}

		certPath := filepath.Join(paths.HostDir, hostname+".pem")
		keyPath := filepath.Join(paths.HostDir, hostname+"-key.pem")

		if !fileExists(certPath) || !fileExists(keyPath) {
			if err := generateHostCert(hostname, tld, paths, caCert); err != nil {
				return nil, err
			}
		}

		cert, err := tls.LoadX509KeyPair(certPath, keyPath)
		if err != nil {
			return nil, err
		}
		return &cert, nil
	}
}

// TrustCA attempts to trust the CA in the system trust store.
// Implementation is platform-specific (certs_darwin.go, certs_linux.go, certs_windows.go).
func TrustCA(paths CertPaths) {
	trustMarker := filepath.Join(filepath.Dir(paths.CACert), ".trusted")
	if fileExists(trustMarker) {
		return
	}

	if err := trustCA(paths.CACert); err != nil {
		fmt.Fprintf(os.Stderr, "[tube] Could not auto-trust CA: %v\n", err)
		fmt.Fprintf(os.Stderr, "[tube] Add %s to your system trust store manually.\n", paths.CACert)
		return
	}

	fmt.Fprintln(os.Stderr, "[tube] CA trusted in system keychain")
	os.WriteFile(trustMarker, []byte("1"), 0644)
}

// ─── Private helpers ────────────────────────────────────────────────────────

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func generateCA(paths CertPaths) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}

	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName: "Tube Local CA",
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return err
	}

	// Write key
	keyBytes, _ := x509.MarshalECPrivateKey(key)
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes})
	os.WriteFile(paths.CAKey, keyPEM, 0600)

	// Write cert
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	os.WriteFile(paths.CACert, certPEM, 0644)

	return nil
}

func generateServerCert(tld string, paths CertPaths) error {
	caCert, err := tls.LoadX509KeyPair(paths.CACert, paths.CAKey)
	if err != nil {
		return err
	}
	ca, _ := x509.ParseCertificate(caCert.Certificate[0])

	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName: "localhost",
		},
		NotBefore: time.Now(),
		NotAfter:  time.Now().AddDate(1, 0, 0),
		KeyUsage:  x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{
			x509.ExtKeyUsageServerAuth,
		},
		DNSNames: []string{"localhost", "*." + tld, "*.local"},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caCert.PrivateKey)
	if err != nil {
		return err
	}

	keyBytes, _ := x509.MarshalECPrivateKey(key)
	os.WriteFile(paths.SrvKey, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes}), 0600)
	os.WriteFile(paths.SrvCert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}), 0644)

	// Serial tracking
	if !fileExists(paths.Srl) {
		os.WriteFile(paths.Srl, []byte("1000\n"), 0644)
	}

	return nil
}

func generateHostCert(hostname, tld string, paths CertPaths, caCert *tls.Certificate) error {
	ca, _ := x509.ParseCertificate(caCert.Certificate[0])

	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName: hostname,
		},
		NotBefore: time.Now(),
		NotAfter:  time.Now().AddDate(1, 0, 0),
		KeyUsage:  x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{
			x509.ExtKeyUsageServerAuth,
		},
		DNSNames: []string{hostname, "*." + tld},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caCert.PrivateKey)
	if err != nil {
		return err
	}

	certPath := filepath.Join(paths.HostDir, hostname+".pem")
	keyPath := filepath.Join(paths.HostDir, hostname+"-key.pem")

	keyBytes, _ := x509.MarshalECPrivateKey(key)
	os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes}), 0600)
	os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}), 0644)

	return nil
}
