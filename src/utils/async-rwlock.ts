/**
 * Readers-writer lock for async code. Any number of readers run together; a
 * writer runs alone. Waiters are served in FIFO order and writers take
 * priority: once a writer is queued, readers that arrive later queue behind
 * it instead of joining the readers already running, so a steady stream of
 * reads cannot starve a write.
 */
export class AsyncRWLock {
    private readers = 0;
    private writing = false;
    private queue: Array<{ write: boolean; resolve: () => void }> = [];

    private acquire(write: boolean): Promise<void> {
        // A reader may join running readers only while nothing is queued (a queued entry is either a writer or a reader behind one).
        const free = write ? !this.writing && this.readers === 0 : !this.writing && this.queue.length === 0;
        if (free) {
            if (write) this.writing = true;
            else this.readers++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => this.queue.push({ write, resolve }));
    }

    private release(write: boolean): void {
        if (write) this.writing = false;
        else this.readers--;
        if (this.writing || this.readers > 0) return;

        // Lock is free: wake the next writer alone, or every reader up to the next queued writer.
        const next = this.queue[0];
        if (!next) return;
        if (next.write) {
            this.queue.shift();
            this.writing = true;
            next.resolve();
            return;
        }
        while (this.queue.length > 0 && !this.queue[0].write) {
            this.readers++;
            this.queue.shift()!.resolve();
        }
    }

    async withRead<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire(false);
        try {
            return await fn();
        } finally {
            this.release(false);
        }
    }

    async withWrite<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire(true);
        try {
            return await fn();
        } finally {
            this.release(true);
        }
    }
}
