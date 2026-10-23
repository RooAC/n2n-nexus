// Task tools: create, get, list, cancel, update_task (Go), and TTL expiry at host start.
import { describe, expect, it } from "vitest";
import { goIt, sleep, useHost } from "./harness.js";

type Task = {
    id: string; status: string; progress: number; source_meeting_id: string | null; metadata: Record<string, unknown>;
    result_uri: string | null; error_message: string | null; created_at: string; updated_at: string; ttl: number | null;
};

const host = useHost();
const create = async (args: Record<string, unknown> = {}) => {
    const res = await host.callTool<{ task_id: string; status: string; task: Task }>("create_task", args);
    expect(res.status, res.body).toBe(200);
    return res.payload.result!;
};
const get = async (taskId: string) => (await host.callTool<Task>("get_task", { taskId })).payload.result;

describe("task tools", () => {
    it("creates pending tasks with metadata and lists them", async () => {
        const meetingId = (await host.callTool<{ meetingId: string }>("start_meeting", { topic: "Tasks" }, "ide-a")).payload.result!.meetingId;
        const created = await create({ metadata: { kind: "demo" }, source_meeting_id: meetingId, ttl: 60_000 });
        await host.callTool("end_meeting", { meetingId }, "ide-a");
        expect(created).toMatchObject({ status: "pending", message: "Task created." });
        expect(created.task).toMatchObject({
            id: created.task_id, status: "pending", progress: 0, source_meeting_id: meetingId, metadata: { kind: "demo" },
            result_uri: null, error_message: null, ttl: 60_000
        });
        expect(await get(created.task_id)).toEqual(created.task);

        const pending = await host.callTool<{ count: number; tasks: Task[] }>("list_tasks", { status: "pending" });
        expect(pending.payload.result?.tasks.map((t) => t.id)).toContain(created.task_id);
        const missing = await host.callTool("get_task", { taskId: "missing" });
        expect(missing.status).toBe(400);
        expect(missing.payload.error).toContain("not found");
    });

    it("cancels only pending or running tasks", async () => {
        const task = await create({ metadata: { kind: "demo" } });
        expect((await host.callTool("cancel_task", { taskId: task.task_id })).status).toBe(200);
        expect((await get(task.task_id))?.status).toBe("cancelled");
        expect((await host.callTool("cancel_task", { taskId: task.task_id })).status).toBe(400);
        expect((await host.callTool("cancel_task", { taskId: "missing" })).status).toBe(400);
    });

    it("marks tasks past their TTL as failed when the host starts", async () => {
        const overdue = await create({ ttl: 1000 });
        const fresh = await create({ ttl: 60 * 60 * 1000 });
        const noTtl = await create();
        await sleep(1100);
        await host.restart();
        expect(await get(overdue.task_id)).toMatchObject({ status: "failed", error_message: "TTL expired" });
        expect((await get(fresh.task_id))?.status).toBe("pending");
        expect((await get(noTtl.task_id))?.status).toBe("pending");
    });

    goIt("update_task changes status, progress, result_uri, error_message and metadata and returns the task", async () => {
        const task = await create({ metadata: { kind: "demo" } });
        const running = await host.callTool<Task>("update_task", { taskId: task.task_id, status: "running", progress: 0.25 });
        expect(running.status, running.body).toBe(200);
        expect(running.payload.result).toMatchObject({ id: task.task_id, status: "running", progress: 0.25, metadata: { kind: "demo" } });

        const done = await host.callTool<Task>("update_task", {
            taskId: task.task_id, status: "completed", progress: 1, result_uri: "file:///out.txt", metadata: { kind: "done" }
        });
        expect(done.payload.result).toMatchObject({ status: "completed", progress: 1, result_uri: "file:///out.txt", metadata: { kind: "done" } });
        expect(await get(task.task_id)).toEqual(done.payload.result);

        const failed = await create();
        const err = await host.callTool<Task>("update_task", { taskId: failed.task_id, status: "failed", error_message: "boom" });
        expect(err.payload.result).toMatchObject({ status: "failed", error_message: "boom" });
    });

    goIt("update_task validates progress 0..1 and refuses unknown tasks", async () => {
        const task = await create();
        for (const progress of [-0.1, 1.5, 7]) {
            const res = await host.callTool("update_task", { taskId: task.task_id, progress });
            expect(res.status, String(progress)).toBe(400);
        }
        expect((await host.callTool("update_task", { taskId: task.task_id, status: "done" })).status).toBe(400);
        expect((await host.callTool("update_task", { progress: 0.5 })).status).toBe(400);
        const missing = await host.callTool("update_task", { taskId: "missing", progress: 0.5 });
        expect(missing.status).toBe(400);
        expect(missing.payload.error).toContain("not found");
        expect((await get(task.task_id))?.progress).toBe(0);
    });
});
