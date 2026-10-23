package service

import (
	"context"
	"io"
	"log"
	"os"
	"os/exec"
	"strconv"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/host"
)

// RestartDelay is how long `serve --supervise` waits before restarting serve.
const RestartDelay = 5 * time.Second

// SuperviseOptions configure Supervise.
type SuperviseOptions struct {
	Exe    string
	Args   []string  // the child's arguments (serve and its flags)
	Out    io.Writer // the child's standard output and error
	Logger *log.Logger
	Delay  time.Duration
}

// Supervise runs Exe Args as a child and starts it again Delay after it
// exits, until ctx ends; then it stops the child and returns. The child gets
// host.SupervisorEnv and cannot outlive the supervisor (a job object on
// Windows; elsewhere the child exits when its parent changes, see WatchSupervisor).
func Supervise(ctx context.Context, o SuperviseOptions) error {
	jobs, err := newChildJobs()
	if err != nil {
		o.Logger.Printf("supervise: %v", err)
	}
	defer jobs.close()
	for {
		cmd := exec.Command(o.Exe, o.Args...)
		cmd.Stdout, cmd.Stderr = o.Out, o.Out
		cmd.Env = append(os.Environ(), host.SupervisorEnv+"="+strconv.Itoa(os.Getpid()))
		HideWindow(cmd)
		if err := cmd.Start(); err != nil {
			o.Logger.Printf("supervise: start serve: %v; retrying in %s", err, o.Delay)
		} else {
			jobs.add(cmd.Process.Pid)
			exited := make(chan error, 1)
			go func() { exited <- cmd.Wait() }()
			select {
			case err := <-exited:
				o.Logger.Printf("supervise: serve (PID %d) exited: %v; restarting in %s", cmd.Process.Pid, exitText(err), o.Delay)
			case <-ctx.Done():
				_ = terminate(cmd.Process)
				select {
				case <-exited:
				case <-time.After(10 * time.Second):
					_ = cmd.Process.Kill()
					<-exited
				}
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(o.Delay):
		}
	}
}

func exitText(err error) string {
	if err == nil {
		return "exit status 0"
	}
	return err.Error()
}
