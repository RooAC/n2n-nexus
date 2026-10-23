-- Projects, documents, meetings, chat, events and tasks (owned by internal/core).

-- One row per project: the manifest's scalar fields as columns, its nested
-- values as JSON, its internal docs as text. position keeps the order projects
-- are listed in (a rename moves the project to the end).
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    tech_stack TEXT NOT NULL,             -- JSON array of strings
    repository_url TEXT NOT NULL,
    local_path TEXT NOT NULL,
    endpoints TEXT NOT NULL,              -- JSON array of {name, url, description}
    api_spec TEXT NOT NULL,               -- JSON array of {method, path, summary}
    billing TEXT,                         -- JSON {plain, price} or NULL
    api_dependencies TEXT,                -- JSON object or NULL
    gateway_compatibility TEXT,
    api_versions TEXT,                    -- JSON object or NULL
    feature_tier TEXT CHECK (feature_tier IN ('standard', 'advanced', 'team')),
    internal_docs TEXT NOT NULL DEFAULT '',
    last_updated TEXT NOT NULL,           -- the manifest's lastUpdated
    last_active TEXT NOT NULL             -- last sync / update
);

-- A project's relations in manifest order. target_id has no foreign key: a
-- relation may name a project that does not exist (yet, or any more); a rename
-- rewrites the targets explicitly.
CREATE TABLE project_relations (
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
    position INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('dependency', 'parent', 'child', 'related')),
    PRIMARY KEY (project_id, position)
);
CREATE INDEX idx_project_relations_target ON project_relations(target_id);

CREATE TABLE project_assets (
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, file_name)
);

CREATE TABLE global_strategy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT NOT NULL,
    updated_at TEXT
);
INSERT INTO global_strategy (id, content) VALUES (1, '# Global Coordination Blueprint

Shared meeting space.');

CREATE TABLE global_docs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

-- is_default marks the meeting send_message and end_meeting use without a
-- meetingId (always an active one); active_order is the order meetings became
-- active, so ending the default one hands the role to the latest still active.
CREATE TABLE meetings (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'archived')),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    active_order INTEGER NOT NULL,
    initiator TEXT NOT NULL,
    participants TEXT NOT NULL,           -- JSON array of instance ids
    created_at TEXT NOT NULL,
    closed_at TEXT,
    summary TEXT,
    CHECK (is_default = 0 OR status = 'active')
);
CREATE INDEX idx_meetings_status ON meetings(status);
CREATE UNIQUE INDEX idx_meetings_default ON meetings(is_default) WHERE is_default = 1;

CREATE TABLE meeting_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    category TEXT CHECK (category IN ('MEETING_START', 'PROPOSAL', 'DECISION', 'UPDATE', 'CHAT')),
    timestamp TEXT NOT NULL
);
CREATE INDEX idx_meeting_messages_meeting ON meeting_messages(meeting_id, id);

CREATE TABLE decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL
);
CREATE INDEX idx_decisions_meeting ON decisions(meeting_id);

-- AUTOINCREMENT: ids are never reused after a prune or clear, so read cursors stay valid.
CREATE TABLE global_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    category TEXT CHECK (category IN ('MEETING_START', 'PROPOSAL', 'DECISION', 'UPDATE', 'CHAT')),
    timestamp TEXT NOT NULL
);

CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT                           -- JSON object or NULL
);
CREATE INDEX idx_events_action ON events(action);
CREATE INDEX idx_events_timestamp ON events(timestamp);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    progress REAL NOT NULL DEFAULT 0.0 CHECK (progress >= 0.0 AND progress <= 1.0),
    source_meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
    metadata TEXT,                        -- JSON object or NULL
    result_uri TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ttl INTEGER                           -- milliseconds
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_meeting ON tasks(source_meeting_id);

-- Last message each instance has read, per context ('global' / 'global' or 'meeting' / meeting id).
CREATE TABLE read_cursors (
    instance_id TEXT NOT NULL,
    context_type TEXT NOT NULL CHECK (context_type IN ('meeting', 'global')),
    context_id TEXT NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (instance_id, context_type, context_id)
);
