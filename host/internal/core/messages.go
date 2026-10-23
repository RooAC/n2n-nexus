package core

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/n2ns/n2n-nexus/host/internal/api"
)

// ---------------------------------------------------------------------------
// send_message

type sendMessageArgs struct {
	Message   string `json:"message"`
	Category  string `json:"category"`
	MeetingID string `json:"meetingId"`
}

func (c *Core) sendMessage(call api.Call, a sendMessageArgs) (any, error) {
	var result map[string]any
	err := c.tx(call, func(tx *sql.Tx) error {
		meetingID := a.MeetingID
		if meetingID == "" {
			var err error
			if meetingID, err = defaultMeetingID(tx); err != nil {
				return err
			}
		}
		if meetingID != "" {
			if err := c.addMeetingMessage(tx, meetingID, call.Actor(), a.Message, a.Category); err != nil {
				return err
			}
			result = map[string]any{"ok": true, "sentTo": "meeting", "meetingId": meetingID,
				"message": fmt.Sprintf("Message sent to meeting %s.", meetingID)}
			return nil
		}
		res, err := tx.Exec(`INSERT INTO global_messages (sender, text, category, timestamp) VALUES (?, ?, ?, ?)`,
			call.Actor(), a.Message, nullString(a.Category), c.now())
		if err != nil {
			return err
		}
		id, err := res.LastInsertId()
		if err != nil {
			return err
		}
		result = map[string]any{"ok": true, "sentTo": "global", "messageId": id, "message": "Message sent to global chat."}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// addMeetingMessage appends to an active meeting, adds the sender to its
// participants and records a DECISION message as a decision.
func (c *Core) addMeetingMessage(tx *sql.Tx, meetingID, from, text, category string) error {
	var status, participantsJSON string
	err := tx.QueryRow(`SELECT status, participants FROM meetings WHERE id = ?`, meetingID).Scan(&status, &participantsJSON)
	if err == sql.ErrNoRows {
		return notFoundMeeting(meetingID)
	}
	if err != nil {
		return err
	}
	if status != "active" {
		return api.Errorf("Meeting '%s' is %s, cannot add messages.", meetingID, status)
	}
	now := c.now()
	if _, err := tx.Exec(`INSERT INTO meeting_messages (meeting_id, sender, text, category, timestamp) VALUES (?, ?, ?, ?, ?)`,
		meetingID, from, text, nullString(category), now); err != nil {
		return err
	}
	var participants []string
	if err := json.Unmarshal([]byte(participantsJSON), &participants); err != nil {
		return err
	}
	known := false
	for _, p := range participants {
		known = known || p == from
	}
	if !known {
		raw, _ := json.Marshal(append(participants, from))
		if _, err := tx.Exec(`UPDATE meetings SET participants = ? WHERE id = ?`, string(raw), meetingID); err != nil {
			return err
		}
	}
	if category == "DECISION" {
		if _, err := tx.Exec(`INSERT INTO decisions (meeting_id, content, timestamp) VALUES (?, ?, ?)`, meetingID, text, now); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// read_messages

type readMessagesArgs struct {
	Count     int    `json:"count"`
	MeetingID string `json:"meetingId"`
}

// meetingMessage: a meeting message without a category has category null.
type meetingMessage struct {
	ID        int64   `json:"id"`
	From      string  `json:"from"`
	Text      string  `json:"text"`
	Category  *string `json:"category"`
	Timestamp string  `json:"timestamp"`
}

// globalMessage: a global message without a category has no category field.
type globalMessage struct {
	ID        int64   `json:"id"`
	From      string  `json:"from"`
	Text      string  `json:"text"`
	Category  *string `json:"category,omitempty"`
	Timestamp string  `json:"timestamp"`
}

func (c *Core) readMessages(call api.Call, a readMessagesArgs) (any, error) {
	if call.InstanceID == "" {
		return nil, api.Errorf("read_messages needs the instanceId field of the POST /api/tools/call body (the n2n-nexus MCP adapter sends it automatically); unread cursors are kept per instance.")
	}
	contextType, contextID := "global", "global"
	query := `SELECT id, sender, text, category, timestamp FROM global_messages WHERE id > ? ORDER BY id LIMIT ?`
	if a.MeetingID != "" {
		contextType, contextID = "meeting", a.MeetingID
		query = `SELECT id, sender, text, category, timestamp FROM meeting_messages WHERE meeting_id = ? AND id > ? ORDER BY id LIMIT ?`
	}
	var messages []globalMessage
	err := c.tx(call, func(tx *sql.Tx) error {
		if a.MeetingID != "" {
			if ok, err := meetingExists(tx, a.MeetingID); err != nil {
				return err
			} else if !ok {
				return notFoundMeeting(a.MeetingID)
			}
		}
		var last int64
		err := tx.QueryRow(`SELECT last_read_id FROM read_cursors WHERE instance_id = ? AND context_type = ? AND context_id = ?`,
			call.InstanceID, contextType, contextID).Scan(&last)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		args := []any{last, a.Count}
		if a.MeetingID != "" {
			args = append([]any{a.MeetingID}, args...)
		}
		rows, err := tx.Query(query, args...)
		if err != nil {
			return err
		}
		for rows.Next() {
			var m globalMessage
			var category sql.NullString
			if err := rows.Scan(&m.ID, &m.From, &m.Text, &category, &m.Timestamp); err != nil {
				rows.Close()
				return err
			}
			if category.Valid {
				m.Category = &category.String
			}
			messages = append(messages, m)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(messages) == 0 {
			return nil
		}
		_, err = tx.Exec(`
			INSERT INTO read_cursors (instance_id, context_type, context_id, last_read_id, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (instance_id, context_type, context_id) DO UPDATE SET last_read_id = excluded.last_read_id, updated_at = excluded.updated_at`,
			call.InstanceID, contextType, contextID, messages[len(messages)-1].ID, c.now())
		return err
	})
	if err != nil {
		return nil, err
	}
	if a.MeetingID == "" {
		if messages == nil {
			messages = []globalMessage{}
		}
		return map[string]any{"source": "global", "messages": messages, "count": len(messages)}, nil
	}
	out := make([]meetingMessage, len(messages))
	for i, m := range messages {
		out[i] = meetingMessage(m)
	}
	return map[string]any{"source": "meeting", "meetingId": a.MeetingID, "messages": out, "count": len(out)}, nil
}

// ---------------------------------------------------------------------------
// list_events

type listEventsArgs struct {
	Limit  int    `json:"limit"`
	Action string `json:"action"`
}

type event struct {
	ID        int64           `json:"id"`
	Timestamp string          `json:"timestamp"`
	Actor     string          `json:"actor"`
	Action    string          `json:"action"`
	Target    string          `json:"target,omitempty"`
	Detail    json.RawMessage `json:"detail,omitempty"`
}

func (c *Core) listEvents(call api.Call, a listEventsArgs) (any, error) {
	events := []event{}
	err := c.tx(call, func(tx *sql.Tx) error {
		var rows *sql.Rows
		var err error
		if a.Action != "" {
			// Exact comparison: LIKE folds ASCII case and treats '_' and '%' as wildcards.
			rows, err = tx.Query(`SELECT id, timestamp, actor, action, target, detail FROM events
				WHERE action = ? OR substr(action, 1, length(?) + 1) = ? || '.' ORDER BY id DESC LIMIT ?`,
				a.Action, a.Action, a.Action, a.Limit)
		} else {
			rows, err = tx.Query(`SELECT id, timestamp, actor, action, target, detail FROM events ORDER BY id DESC LIMIT ?`, a.Limit)
		}
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e event
			var target, detail sql.NullString
			if err := rows.Scan(&e.ID, &e.Timestamp, &e.Actor, &e.Action, &target, &detail); err != nil {
				return err
			}
			e.Target = target.String
			if detail.Valid && detail.String != "" {
				e.Detail = json.RawMessage(detail.String)
			}
			events = append(events, e)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"count": len(events), "events": events}, nil
}

// ---------------------------------------------------------------------------
// host_maintenance

type maintenanceArgs struct {
	Action string `json:"action"`
	Count  int64  `json:"count"`
}

func (c *Core) hostMaintenance(call api.Call, a maintenanceArgs) (any, error) {
	if a.Action == "prune" && a.Count < 1 {
		return nil, api.Errorf("host_maintenance prune needs count ≥ 1 (the number of oldest global messages to remove); use action \"clear\" to remove all.")
	}
	var removed, remaining int64
	err := c.tx(call, func(tx *sql.Tx) error {
		var err error
		switch {
		case a.Action == "clear":
			removed, err = exec(tx, `DELETE FROM global_messages`)
		case a.Count > 0:
			removed, err = exec(tx, `DELETE FROM global_messages WHERE id IN (SELECT id FROM global_messages ORDER BY id LIMIT ?)`, a.Count)
		}
		if err != nil {
			return err
		}
		if err := tx.QueryRow(`SELECT COUNT(*) FROM global_messages`).Scan(&remaining); err != nil {
			return err
		}
		return c.recordEvent(tx, call.Actor(), "maintenance."+a.Action, "", map[string]any{"removed": removed})
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "removed": removed, "remaining": remaining,
		"message": fmt.Sprintf("Removed %d global messages.", removed)}, nil
}
