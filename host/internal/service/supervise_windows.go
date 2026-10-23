package service

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// childJobs is a job object that kills the children when the supervisor's
// handle to it closes, i.e. when the supervisor ends (Stop-ScheduledTask
// terminates only the task's own process).
type childJobs struct{ job windows.Handle }

func newChildJobs() (*childJobs, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return &childJobs{}, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return &childJobs{}, err
	}
	return &childJobs{job: job}, nil
}

func (j *childJobs) add(pid int) {
	if j.job == 0 {
		return
	}
	p, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(p)
	_ = windows.AssignProcessToJobObject(j.job, p)
}

func (j *childJobs) close() {
	if j.job != 0 {
		windows.CloseHandle(j.job)
	}
}

// terminate ends the child; Windows cannot deliver a graceful signal to it.
func terminate(p *os.Process) error { return p.Kill() }

// WatchSupervisor does nothing on Windows: the supervisor's job object ends the child.
func WatchSupervisor(int, func()) {}
