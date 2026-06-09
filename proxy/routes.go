package proxy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// RouteInfo represents a registered backend route.
type RouteInfo struct {
	Hostname string `json:"hostname"`
	Port     int    `json:"port"`
	PID      int    `json:"pid"`
	LocalURL string `json:"localUrl"`
}

// RouteStore polls routes.json and provides lookups.
type RouteStore struct {
	mu       sync.RWMutex
	routes   []RouteInfo
	path     string
	tld      string
	stopCh   chan struct{}
	onChange func([]RouteInfo)
}

// NewRouteStore creates a store that polls the given routes file.
func NewRouteStore(routesPath, tld string) *RouteStore {
	return &RouteStore{
		path:   routesPath,
		tld:    tld,
		stopCh: make(chan struct{}),
	}
}

// SetOnChange sets a callback that fires when routes change.
func (s *RouteStore) SetOnChange(fn func([]RouteInfo)) {
	s.onChange = fn
}

// Start begins polling the routes file every 3 seconds.
func (s *RouteStore) Start() {
	s.poll()
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				s.poll()
			case <-s.stopCh:
				return
			}
		}
	}()
}

// Stop stops polling.
func (s *RouteStore) Stop() {
	close(s.stopCh)
}

// FindRoute looks up a route by hostname with TLD enforcement.
func (s *RouteStore) FindRoute(host string) *RouteInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if host != s.tld && !strings.HasSuffix(host, "."+s.tld) {
		return nil
	}

	for i := range s.routes {
		if s.routes[i].Hostname == host {
			return &s.routes[i]
		}
	}
	return nil
}

// All returns all active routes.
func (s *RouteStore) All() []RouteInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]RouteInfo, len(s.routes))
	copy(out, s.routes)
	for i := range out {
		out[i].LocalURL = "https://" + out[i].Hostname
		out[i].PID = 0
	}
	return out
}

// RouteFilePath returns the default routes.json path.
func RouteFilePath() string {
	home, _ := os.UserHomeDir()
	dir := os.Getenv("TUBE_STATE_DIR")
	if dir == "" {
		dir = filepath.Join(home, ".tube")
	}
	return filepath.Join(dir, "routes.json")
}

func (s *RouteStore) poll() {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return
	}

	var parsed []struct {
		Hostname string `json:"hostname"`
		Port     int    `json:"port"`
	}

	if err := json.Unmarshal(data, &parsed); err != nil {
		return
	}

	routes := make([]RouteInfo, 0, len(parsed))
	for _, r := range parsed {
		if r.Hostname != "" && r.Port > 0 {
			routes = append(routes, RouteInfo{
				Hostname: r.Hostname,
				Port:     r.Port,
				LocalURL: "https://" + r.Hostname,
			})
		}
	}

	s.mu.Lock()
	s.routes = routes
	s.mu.Unlock()

	if s.onChange != nil {
		s.onChange(routes)
	}
}
