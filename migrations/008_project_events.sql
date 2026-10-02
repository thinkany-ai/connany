-- Project-wide event feed: backends poll one stream for all of their users.
CREATE INDEX IF NOT EXISTS events_project ON events(project_id, seq);
