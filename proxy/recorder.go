package proxy

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

// CaptureEntry represents a recorded HTTP request/response.
type CaptureEntry struct {
	ID              string            `json:"id"`
	Timestamp       int64             `json:"timestamp"`
	Method          string            `json:"method"`
	Path            string            `json:"path"`
	Host            string            `json:"host"`
	RequestHeaders  map[string]string `json:"requestHeaders"`
	RequestBody     string            `json:"requestBody"`
	StatusCode      int               `json:"statusCode"`
	ResponseHeaders map[string]string `json:"responseHeaders"`
	ResponseBody    string            `json:"responseBody"`
	Duration        int64             `json:"duration"`
}

// Recorder is a thread-safe ring buffer for HTTP captures.
type Recorder struct {
	mu       sync.RWMutex
	buffer   []CaptureEntry
	maxSize  int
	listener func(CaptureEntry)
}

// NewRecorder creates a recorder with the given max buffer size.
func NewRecorder(maxSize int) *Recorder {
	return &Recorder{
		maxSize: maxSize,
		buffer:  make([]CaptureEntry, 0, maxSize),
	}
}

// Record stores a new capture entry. Drops oldest if over capacity.
// Emits to the listener callback if set.
func (r *Recorder) Record(entry CaptureEntry) {
	entry.ID = uuid.NewString()
	entry.Timestamp = time.Now().UnixMilli()

	r.mu.Lock()
	r.buffer = append(r.buffer, entry)
	if len(r.buffer) > r.maxSize {
		r.buffer = r.buffer[1:]
	}
	r.mu.Unlock()

	if r.listener != nil {
		r.listener(entry)
	}
}

// All returns a copy of all buffered captures.
func (r *Recorder) All() []CaptureEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]CaptureEntry, len(r.buffer))
	copy(out, r.buffer)
	return out
}

// Count returns the number of buffered captures.
func (r *Recorder) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.buffer)
}

// SetListener sets a callback that fires on each new capture.
func (r *Recorder) SetListener(fn func(CaptureEntry)) {
	r.listener = fn
}
