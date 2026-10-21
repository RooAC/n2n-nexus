import { promises as fs } from "node:fs";
import { NexusPaths } from "./paths.js";
import { toDict, writeFileAtomic, writeJsonAtomic } from "./fs-utils.js";
import { ProjectManifest } from "../types.js";

export type RegistryData = {
    projects: Record<string, {
        name?: string;
        summary: string;
        lastActive: string;
    }>;
};

const emptyRegistry = (): RegistryData => ({ projects: toDict() });

async function readRegistry(): Promise<RegistryData> {
    try {
        const raw = await fs.readFile(NexusPaths.registryFile, "utf-8");
        const parsed = JSON.parse(raw);
        return sanitizeRegistry(parsed);
    } catch {
        return emptyRegistry();
    }
}

function sanitizeRegistry(data: unknown): RegistryData {
    if (!data || typeof data !== "object") return emptyRegistry();
    const root = data as { projects?: unknown };
    if (!root.projects || typeof root.projects !== "object") return emptyRegistry();

    return {
        projects: toDict(
            Object.entries(root.projects as Record<string, unknown>).map(([id, item]) => {
                if (!item || typeof item !== "object") {
                    return [id, {
                        summary: "",
                        lastActive: new Date().toISOString()
                    }];
                }
                const entry = item as { name?: unknown; summary?: unknown; lastActive?: unknown };
                return [id, {
                    name: typeof entry.name === "string" ? entry.name : undefined,
                    summary: typeof entry.summary === "string" ? entry.summary : "",
                    lastActive: typeof entry.lastActive === "string" ? entry.lastActive : new Date().toISOString()
                }];
            })
        )
    };
}

async function writeRegistry(data: RegistryData): Promise<void> {
    await writeJsonAtomic(NexusPaths.registryFile, data);
}

async function readProjectManifest(id: string): Promise<Partial<ProjectManifest> | null> {
    try {
        const raw = await fs.readFile(NexusPaths.projectManifestPath(id), "utf-8");
        return JSON.parse(raw) as Partial<ProjectManifest>;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Read-side normalization of stored manifests. Before 0.6, update_project
// wrote patches to disk unvalidated, so nested entries can lack fields or
// carry extra ones. Readers get well-formed values; the file is not rewritten.
// ---------------------------------------------------------------------------

type Relation = ProjectManifest["relations"][number];
const RELATION_TYPES: Relation["type"][] = ["dependency", "parent", "child", "related"];
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const objects = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : [];
const stringRecord = (v: unknown): Record<string, string> | undefined => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string>;
};

/** Relations with a string targetId; an unknown or missing type reads as "related". */
export function normalizeRelations(v: unknown): Relation[] {
    return objects(v)
        .filter((r) => typeof r.targetId === "string" && r.targetId)
        .map((r) => ({
            targetId: r.targetId as string,
            type: RELATION_TYPES.includes(r.type as Relation["type"]) ? r.type as Relation["type"] : "related"
        }));
}

function normalizeManifestFields(raw: Partial<ProjectManifest> | null) {
    const m = (raw ?? {}) as Record<string, unknown>;
    const billing = m.billing && typeof m.billing === "object"
        ? { plain: str((m.billing as Record<string, unknown>).plain), price: str((m.billing as Record<string, unknown>).price) }
        : undefined;
    const tiers = ["standard", "advanced", "team"];
    return {
        name: typeof m.name === "string" ? m.name : undefined,
        description: typeof m.description === "string" ? m.description : undefined,
        techStack: Array.isArray(m.techStack) ? m.techStack.filter((t): t is string => typeof t === "string") : [],
        relations: normalizeRelations(m.relations),
        lastUpdated: typeof m.lastUpdated === "string" && m.lastUpdated ? m.lastUpdated : undefined,
        repositoryUrl: str(m.repositoryUrl),
        localPath: typeof m.localPath === "string" && m.localPath ? m.localPath : undefined,
        endpoints: objects(m.endpoints).map((e) => ({ name: str(e.name), url: str(e.url), description: str(e.description) })),
        apiSpec: objects(m.apiSpec).map((e) => ({ method: str(e.method), path: str(e.path), summary: str(e.summary) })),
        billing,
        apiDependencies: stringRecord(m.apiDependencies),
        gatewayCompatibility: typeof m.gatewayCompatibility === "string" ? m.gatewayCompatibility : undefined,
        api_versions: stringRecord(m.api_versions),
        feature_tier: tiers.includes(m.feature_tier as string) ? m.feature_tier as ProjectManifest["feature_tier"] : undefined
    };
}

export class RegistryStorage {
    static async listRegistry(): Promise<RegistryData> {
        return readRegistry();
    }

    static async saveProjectManifest(manifest: ProjectManifest): Promise<void> {
        const projectDir = NexusPaths.projectDir(manifest.id);
        const manifestPath = NexusPaths.projectManifestPath(manifest.id);
        const registry = await readRegistry();
        registry.projects[manifest.id] = {
            name: manifest.name,
            summary: manifest.description || "",
            lastActive: new Date().toISOString()
        };
        await writeRegistry(registry);

        await fs.mkdir(projectDir, { recursive: true });
        await writeJsonAtomic(manifestPath, { ...manifest, lastUpdated: manifest.lastUpdated || new Date().toISOString() });
    }

    static async getProjectManifest(id: string): Promise<ProjectManifest | null> {
        const registry = await readRegistry();
        const entry = registry.projects[id];
        if (!entry) return null;

        const m = normalizeManifestFields(await readProjectManifest(id));
        return {
            id,
            name: entry.name || m.name || id,
            description: entry.summary || m.description || "",
            techStack: m.techStack,
            relations: m.relations,
            lastUpdated: m.lastUpdated || entry.lastActive,
            repositoryUrl: m.repositoryUrl,
            localPath: m.localPath || NexusPaths.projectDir(id),
            endpoints: m.endpoints,
            apiSpec: m.apiSpec,
            billing: m.billing,
            apiDependencies: m.apiDependencies,
            gatewayCompatibility: m.gatewayCompatibility,
            api_versions: m.api_versions,
            feature_tier: m.feature_tier
        };
    }

    static async patchProjectManifest(id: string, patch: Partial<ProjectManifest>): Promise<void> {
        const registry = await readRegistry();
        const existing = registry.projects[id];
        if (!existing) throw new Error(`Project '${id}' not found.`);

        registry.projects[id] = {
            ...existing,
            summary: patch.description ?? existing.summary,
            name: patch.name ?? existing.name,
            lastActive: new Date().toISOString()
        };
        await writeRegistry(registry);

        const manifest = await readProjectManifest(id) || {};
        const patchedManifest: ProjectManifest = {
            id,
            name: patch.name ?? manifest.name ?? existing.name ?? "",
            description: patch.description ?? manifest.description ?? "",
            techStack: patch.techStack ?? manifest.techStack ?? [],
            relations: patch.relations ?? manifest.relations ?? [],
            lastUpdated: new Date().toISOString(),
            repositoryUrl: patch.repositoryUrl ?? manifest.repositoryUrl ?? "",
            localPath: patch.localPath ?? manifest.localPath ?? NexusPaths.projectDir(id),
            endpoints: patch.endpoints ?? manifest.endpoints ?? [],
            apiSpec: patch.apiSpec ?? manifest.apiSpec ?? [],
            billing: patch.billing ?? manifest.billing,
            apiDependencies: patch.apiDependencies ?? manifest.apiDependencies,
            gatewayCompatibility: patch.gatewayCompatibility ?? manifest.gatewayCompatibility,
            api_versions: patch.api_versions ?? manifest.api_versions,
            feature_tier: patch.feature_tier ?? manifest.feature_tier
        };
        await writeJsonAtomic(NexusPaths.projectManifestPath(id), patchedManifest);
    }

    static async calculateTopology(projectId?: string) {
        const registry = await readRegistry();
        const projectRecords = await Promise.all(
            Object.entries(registry.projects).map(async ([id, project]) => {
                const manifest = await readProjectManifest(id);
                return {
                    id,
                    name: manifest?.name || project.name || id,
                    summary: project.summary,
                    lastActive: project.lastActive,
                    relations: normalizeRelations(manifest?.relations)
                };
            })
        );

        const nodeMap = new Map(projectRecords.map((record) => [record.id, record]));
        const edges = projectRecords.flatMap((project) => {
            return project.relations
                .filter(relation => nodeMap.has(relation.targetId))
                .map((relation) => ({
                    from: project.id,
                    to: relation.targetId,
                    type: relation.type
                }));
        });

        const allProjects = projectRecords.map((project) => ({
            id: project.id,
            name: project.name,
            summary: project.summary,
            lastActive: project.lastActive
        }));

        if (!projectId) {
            return {
                mode: "list" as const,
                summary: {
                    totalProjects: allProjects.length,
                    totalEdges: edges.length
                },
                projects: Object.fromEntries(allProjects.map((project) => [project.id, project]))
            };
        }

        if (!nodeMap.has(projectId)) {
            return {
                mode: "focused" as const,
                nodes: [],
                edges: []
            };
        }

        const visited = new Set<string>();
        const queue = [projectId];
        while (queue.length > 0) {
            const current = queue.shift();
            if (!current || visited.has(current)) {
                continue;
            }
            visited.add(current);
            for (const edge of edges) {
                if (edge.from === current && !visited.has(edge.to)) {
                    queue.push(edge.to);
                }
            }
        }

        return {
            mode: "focused" as const,
            nodes: allProjects.filter((project) => visited.has(project.id)),
            edges: edges.filter((edge) => visited.has(edge.from) && visited.has(edge.to))
        };
    }

    static async deleteProject(projectId: string): Promise<number> {
        const registry = await readRegistry();
        if (!registry.projects[projectId]) return 0;
        delete registry.projects[projectId];
        await writeRegistry(registry);
        return 1;
    }

    /**
     * Renames a project as one unit: its directory, its own manifest id, every
     * relation that targets it in other manifests, and the registry key.
     *
     * Order: directory rename, then manifest writes, then the registry write
     * last. The registry is the index readers trust, so it only switches to
     * the new id once everything it points at is in place. If any step
     * throws, the completed steps are undone in reverse (manifests restored to
     * their original bytes, directory renamed back) and the original error is
     * rethrown. Rollback is best effort: a failure while undoing is swallowed
     * so the caller still sees the error that caused the rollback.
     *
     * Returns 0 when oldId is not registered or its directory does not exist.
     */
    static async renameProject(oldId: string, newId: string): Promise<number> {
        if (!oldId || !newId || oldId === newId) return 0;
        const registry = await readRegistry();
        if (!registry.projects[oldId]) return 0;
        if (registry.projects[newId]) {
            throw new Error(`Project '${newId}' already exists.`);
        }

        const oldDir = NexusPaths.projectDir(oldId);
        const newDir = NexusPaths.projectDir(newId);
        try {
            await fs.access(oldDir);
        } catch {
            return 0;
        }

        // Plan every manifest rewrite before touching disk. `original` keeps
        // the exact bytes for rollback; `path` is where the file lives after
        // the directory rename.
        const rewrites: { path: string; original: string; updated: Partial<ProjectManifest> }[] = [];
        for (const projectId of Object.keys(registry.projects)) {
            let original: string;
            try {
                original = await fs.readFile(NexusPaths.projectManifestPath(projectId), "utf-8");
            } catch {
                continue;
            }
            let manifest: Partial<ProjectManifest>;
            try {
                manifest = JSON.parse(original) as Partial<ProjectManifest>;
            } catch {
                continue;
            }

            let changed = false;
            if (projectId === oldId) {
                manifest.id = newId;
                changed = true;
            }
            if (Array.isArray(manifest.relations)) {
                manifest.relations = manifest.relations.map((relation) => {
                    if (relation?.targetId !== oldId) return relation;
                    changed = true;
                    return { ...relation, targetId: newId };
                });
            }
            if (changed) {
                const target = projectId === oldId ? newId : projectId;
                rewrites.push({ path: NexusPaths.projectManifestPath(target), original, updated: manifest });
            }
        }

        let dirMoved = false;
        const written: typeof rewrites = [];
        try {
            await fs.mkdir(NexusPaths.projectsRoot, { recursive: true });
            await fs.rename(oldDir, newDir);
            dirMoved = true;

            for (const rewrite of rewrites) {
                await writeJsonAtomic(rewrite.path, rewrite.updated);
                written.push(rewrite);
            }

            const entry = registry.projects[oldId];
            delete registry.projects[oldId];
            registry.projects[newId] = entry;
            await writeRegistry(registry);
        } catch (error) {
            for (const rewrite of written.reverse()) {
                await writeFileAtomic(rewrite.path, rewrite.original).catch(() => { });
            }
            if (dirMoved) {
                await fs.rename(newDir, oldDir).catch(() => { });
            }
            throw error;
        }

        return 1;
    }
}
