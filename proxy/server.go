package proxy

import (
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

// ServerConfig holds all configuration for the Tube proxy server.
type ServerConfig struct {
	TLD       string
	ProxyPort int
	APIPort   int
	NoTLS     bool
	Routes    *RouteStore
	Recorder  *Recorder
	Tunnels   *TunnelManager
}

// StartServer starts the HTTPS proxy and optional HTTP redirect.
func StartServer(cfg *ServerConfig) (*http.Server, *http.Server, error) {
	// ── Proxy handler ─────────────────────────────────────────────────────
	proxyHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := strings.Split(r.Host, ":")[0]

		if host == "" {
			http.Error(w, "Missing Host header", http.StatusBadRequest)
			return
		}

		route := cfg.Routes.FindRoute(host)
		if route == nil {
			http.Error(w, "No app registered for "+host, http.StatusNotFound)
			return
		}

		// Read request body
		reqBody, _ := io.ReadAll(r.Body)
		r.Body.Close()

		start := time.Now()

		// Build target URL
		target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", route.Port))
		proxy := httputil.NewSingleHostReverseProxy(target)
		proxy.Director = func(req *http.Request) {
			req.URL.Scheme = "http"
			req.URL.Host = target.Host
			req.URL.Path = r.URL.Path
			req.URL.RawQuery = r.URL.RawQuery
			req.Host = target.Host

			// Forward headers (strip hop-by-hop)
			for k, vv := range r.Header {
				kl := strings.ToLower(k)
				if kl == "host" || kl == "connection" || kl == "keep-alive" ||
					kl == "transfer-encoding" || kl == "upgrade" || kl == "te" {
					continue
				}
				for _, v := range vv {
					req.Header.Add(k, v)
				}
			}
			req.Header.Set("X-Forwarded-For", "127.0.0.1")
			scheme := "http"
			if r.TLS != nil {
				scheme = "https"
			}
			req.Header.Set("X-Forwarded-Proto", scheme)
			req.Header.Set("X-Forwarded-Host", host)
		}

		// Capture response via custom response writer
		crw := &captureResponseWriter{ResponseWriter: w, statusCode: 200}
		proxy.ServeHTTP(crw, r)

		duration := time.Since(start).Milliseconds()

		// Record
		reqHeaders := make(map[string]string)
		for k, vv := range r.Header {
			reqHeaders[k] = strings.Join(vv, ", ")
		}

		resHeaders := make(map[string]string)
		for k, vv := range crw.Header() {
			resHeaders[k] = strings.Join(vv, ", ")
		}

		// Cap body sizes for the ring buffer
		reqBodyStr := string(reqBody)
		if len(reqBodyStr) > 5000 {
			reqBodyStr = reqBodyStr[:5000]
		}
		resBodyStr := crw.body.String()
		if len(resBodyStr) > 5000 {
			resBodyStr = resBodyStr[:5000]
		}

		cfg.Recorder.Record(CaptureEntry{
			Method:          r.Method,
			Path:            r.URL.RequestURI(),
			Host:            host,
			RequestHeaders:  reqHeaders,
			RequestBody:     reqBodyStr,
			StatusCode:      crw.statusCode,
			ResponseHeaders: resHeaders,
			ResponseBody:    resBodyStr,
			Duration:        duration,
		})
	})

	// ── TLS config ────────────────────────────────────────────────────────
	var tlsCfg *tls.Config
	var cert *tls.Certificate

	if !cfg.NoTLS {
		paths := DefaultCertPaths()
		var err error
		cert, _, err = LoadOrGenerateCerts(cfg.TLD, paths)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[tube] TLS cert error: %v — falling back to HTTP\n", err)
		} else {
			TrustCA(paths)
			// Load CA for SNI callback
			caCert, err := tls.LoadX509KeyPair(paths.CACert, paths.CAKey)
			if err == nil {
				sniCB := SNICallback(cfg.TLD, paths, &caCert)
				tlsCfg = &tls.Config{
					Certificates: []tls.Certificate{*cert},
					GetCertificate: sniCB,
					MinVersion: tls.VersionTLS12,
				}
			} else {
				tlsCfg = &tls.Config{
					Certificates: []tls.Certificate{*cert},
					MinVersion:   tls.VersionTLS12,
				}
			}
		}
	}

	// ── Create servers ────────────────────────────────────────────────────
	proxySrv := &http.Server{
		Addr:      fmt.Sprintf(":%d", cfg.ProxyPort),
		Handler:   proxyHandler,
		TLSConfig: tlsCfg,
	}

	var redirectSrv *http.Server

	// HTTP → HTTPS redirect
	if tlsCfg != nil && cfg.ProxyPort == 443 {
		redirectSrv = &http.Server{
			Addr: ":80",
			Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				host := strings.Split(r.Host, ":")[0]
				if host == "" {
					host = "localhost"
				}
				target := fmt.Sprintf("https://%s%s", host, r.URL.RequestURI())
				http.Redirect(w, r, target, http.StatusMovedPermanently)
			}),
		}
		go func() {
			fmt.Fprintf(os.Stderr, "[tube] Redirect: 80 → :%d\n", cfg.ProxyPort)
			if err := redirectSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				fmt.Fprintf(os.Stderr, "[tube] Redirect error: %v\n", err)
			}
		}()
	}

	go func() {
		proto := "HTTP"
		if tlsCfg != nil {
			proto = "HTTPS"
		}
		fmt.Fprintf(os.Stderr, "[tube] Proxy (%s): %d\n", proto, cfg.ProxyPort)

		var err error
		if tlsCfg != nil {
			proxySrv.TLSConfig = tlsCfg
			err = proxySrv.ListenAndServeTLS("", "")
		} else {
			err = proxySrv.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			fmt.Fprintf(os.Stderr, "[tube] Proxy error: %v\n", err)
		}
	}()

	return proxySrv, redirectSrv, nil
}

// captureResponseWriter wraps http.ResponseWriter to capture status code and body.
type captureResponseWriter struct {
	http.ResponseWriter
	statusCode int
	body       strings.Builder
}

func (w *captureResponseWriter) WriteHeader(code int) {
	w.statusCode = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *captureResponseWriter) Write(b []byte) (int, error) {
	w.body.Write(b)
	return w.ResponseWriter.Write(b)
}
