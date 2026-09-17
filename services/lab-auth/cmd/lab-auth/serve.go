package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/example-org/example-blog/services/lab-auth/internal/config"
	"github.com/example-org/example-blog/services/lab-auth/internal/server"
)

func cmdServe(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("serve")
	insecureCookies := fs.Bool("insecure-cookies", false, "allow non-Secure cookies (local http only)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load(config.OS)
	if err != nil {
		return err
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	st, err := openStore(cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()

	logger := slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	srv, err := server.New(cfg, st, server.Options{
		InsecureCookies: *insecureCookies,
		Logger:          logger,
	})
	if err != nil {
		return err
	}

	listener, cleanup, err := listen(cfg.Listen)
	if err != nil {
		return err
	}
	defer cleanup()

	httpServer := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cleanupCtx, cancelCleanup := context.WithCancel(context.Background())
	defer cancelCleanup()
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-cleanupCtx.Done():
				return
			case <-ticker.C:
				srv.Cleanup()
			}
		}
	}()

	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.Serve(listener) }()
	fmt.Fprintf(stderr, "lab-auth listening on %s\n", cfg.Listen)

	select {
	case <-ctx.Done():
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownGrace)
	defer cancel()
	return httpServer.Shutdown(shutdownCtx)
}

func listen(addr string) (net.Listener, func(), error) {
	if strings.HasPrefix(addr, "unix:") {
		path := strings.TrimPrefix(addr, "unix:")
		_ = os.Remove(path)
		listener, err := net.Listen("unix", path)
		if err != nil {
			return nil, nil, err
		}
		if err := os.Chmod(path, 0o660); err != nil {
			listener.Close()
			return nil, nil, err
		}
		return listener, func() { listener.Close(); os.Remove(path) }, nil
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, nil, err
	}
	return listener, func() { listener.Close() }, nil
}
