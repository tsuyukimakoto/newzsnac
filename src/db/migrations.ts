export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "sources_items_and_user_state",
    sql: `
      CREATE TABLE sources (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('rss', 'atom', 'hacker_news', 'bluesky', 'zenn')),
        canonical_url TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
        group_name TEXT,
        base_priority INTEGER NOT NULL DEFAULT 50 CHECK (base_priority BETWEEN 0 AND 100),
        fetch_interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (fetch_interval_minutes > 0),
        language TEXT,
        summary_enabled INTEGER NOT NULL DEFAULT 1 CHECK (summary_enabled IN (0, 1)),
        translate_title INTEGER NOT NULL DEFAULT 0 CHECK (translate_title IN (0, 1)),
        fetch_full_text INTEGER NOT NULL DEFAULT 1 CHECK (fetch_full_text IN (0, 1)),
        retention_days INTEGER,
        excluded_keywords_json TEXT NOT NULL DEFAULT '[]',
        cursor TEXT,
        etag TEXT,
        last_modified TEXT,
        last_checked_at TEXT,
        next_fetch_at TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        canonical_url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        author TEXT,
        original_language TEXT,
        published_at TEXT,
        discovered_at TEXT NOT NULL,
        feed_content TEXT,
        extracted_content TEXT,
        content_hash TEXT,
        extraction_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (extraction_status IN ('pending', 'available', 'failed')),
        estimated_reading_minutes INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE source_items (
        source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        external_id TEXT,
        source_url TEXT NOT NULL,
        source_title TEXT,
        discovered_at TEXT NOT NULL,
        raw_metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (source_id, item_id),
        UNIQUE (source_id, external_id)
      );

      CREATE TABLE item_analyses (
        id INTEGER PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('analysis', 'translation')),
        model_id TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        summary_ja TEXT,
        labels_json TEXT,
        priority INTEGER CHECK (priority BETWEEN 0 AND 100),
        reasons_json TEXT,
        item_type TEXT,
        original_language TEXT,
        translated_content TEXT,
        analyzed_at TEXT NOT NULL,
        UNIQUE (item_id, kind, model_id, prompt_version)
      );

      CREATE TABLE item_user_states (
        item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
        is_saved INTEGER NOT NULL DEFAULT 0 CHECK (is_saved IN (0, 1)),
        interest TEXT CHECK (interest IN ('interested', 'not_interested')),
        read_at TEXT,
        saved_at TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "relationships_candidates_history_and_sessions",
    sql: `
      CREATE TABLE related_item_groups (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE related_item_members (
        group_id INTEGER NOT NULL REFERENCES related_item_groups(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        similarity REAL,
        reason TEXT,
        PRIMARY KEY (group_id, item_id)
      );

      CREATE TABLE source_candidates (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        canonical_url TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        estimated_weekly_count REAL,
        overlap_ratio REAL CHECK (overlap_ratio BETWEEN 0 AND 1),
        recent_items_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'candidate'
          CHECK (status IN ('candidate', 'hidden', 'dismissed', 'subscribed')),
        hidden_until TEXT,
        verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE source_candidate_evidence (
        candidate_id INTEGER NOT NULL REFERENCES source_candidates(id) ON DELETE CASCADE,
        item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
        evidence_type TEXT NOT NULL,
        evidence_value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (candidate_id, item_id, evidence_type, evidence_value)
      );

      CREATE TABLE action_history (
        id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        caller TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        result TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE reading_sessions (
        id INTEGER PRIMARY KEY,
        view_name TEXT,
        query_json TEXT NOT NULL,
        sort_order TEXT NOT NULL,
        baseline_at TEXT NOT NULL,
        current_item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
        scroll_offset REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: "leased_jobs",
    sql: `
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
        source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'running', 'retry_wait', 'completed', 'failed')),
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX jobs_claimable_idx
        ON jobs(status, available_at, priority DESC, id);
    `,
  },
  {
    version: 4,
    name: "item_full_text_search",
    sql: `
      CREATE VIRTUAL TABLE item_search USING fts5(
        title,
        author,
        content,
        summary,
        labels,
        content=''
      );

      CREATE TRIGGER items_search_insert AFTER INSERT ON items BEGIN
        INSERT INTO item_search(rowid, title, author, content, summary, labels)
        VALUES (new.id, new.title, coalesce(new.author, ''),
          coalesce(new.extracted_content, new.feed_content, ''), '', '');
      END;
      CREATE TRIGGER items_search_update AFTER UPDATE OF title, author, extracted_content, feed_content ON items BEGIN
        INSERT INTO item_search(item_search, rowid, title, author, content, summary, labels)
        VALUES ('delete', old.id, old.title, coalesce(old.author, ''),
          coalesce(old.extracted_content, old.feed_content, ''), '', '');
        INSERT INTO item_search(rowid, title, author, content, summary, labels)
        VALUES (new.id, new.title, coalesce(new.author, ''),
          coalesce(new.extracted_content, new.feed_content, ''), '', '');
      END;
      CREATE TRIGGER items_search_delete AFTER DELETE ON items BEGIN
        INSERT INTO item_search(item_search, rowid, title, author, content, summary, labels)
        VALUES ('delete', old.id, old.title, coalesce(old.author, ''),
          coalesce(old.extracted_content, old.feed_content, ''), '', '');
      END;
      CREATE TRIGGER analyses_search_insert AFTER INSERT ON item_analyses
      WHEN new.kind = 'analysis' BEGIN
        INSERT INTO item_search(item_search, rowid, title, author, content, summary, labels)
        SELECT 'delete', i.id, i.title, coalesce(i.author, ''),
          coalesce(i.extracted_content, i.feed_content, ''), '', '' FROM items i WHERE i.id = new.item_id;
        INSERT INTO item_search(rowid, title, author, content, summary, labels)
        SELECT i.id, i.title, coalesce(i.author, ''),
          coalesce(i.extracted_content, i.feed_content, ''), coalesce(new.summary_ja, ''),
          coalesce(new.labels_json, '') FROM items i WHERE i.id = new.item_id;
      END;
    `,
  },
  {
    version: 5,
    name: "smart_views",
    sql: `
      CREATE TABLE smart_views (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        query TEXT NOT NULL,
        filters_json TEXT NOT NULL DEFAULT '{}',
        sort_order TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: "retry_analysis_jobs_after_lm_schema_fix",
    sql: `
      UPDATE jobs
      SET status = 'pending', attempts = 0, available_at = CURRENT_TIMESTAMP,
        lease_owner = NULL, lease_expires_at = NULL, last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE type = 'analysis'
        AND status IN ('retry_wait', 'failed')
        AND last_error = 'LM Studio returned HTTP 400';
    `,
  },
  {
    version: 7,
    name: "item_embeddings_and_recommendations",
    sql: `
      CREATE TABLE item_embeddings (
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        input_version TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        vector BLOB NOT NULL,
        l2_norm REAL NOT NULL CHECK (l2_norm > 0),
        embedded_at TEXT NOT NULL,
        PRIMARY KEY (item_id, model_id, input_version)
      );
      CREATE INDEX item_embeddings_model_idx
        ON item_embeddings(model_id, input_version, item_id);

      CREATE TABLE item_recommendations (
        target_item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        source_item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        score REAL NOT NULL CHECK (score >= -1 AND score <= 1),
        model_id TEXT NOT NULL,
        input_version TEXT NOT NULL,
        calculated_at TEXT NOT NULL,
        CHECK (target_item_id <> source_item_id)
      );
      CREATE INDEX item_recommendations_source_idx
        ON item_recommendations(source_item_id, target_item_id);
      CREATE INDEX item_recommendations_score_idx
        ON item_recommendations(score DESC, target_item_id DESC);
    `,
  },
  {
    version: 8,
    name: "article_chat_messages",
    sql: `
      CREATE TABLE article_chat_messages (
        id INTEGER PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL CHECK (length(content) > 0),
        model_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX article_chat_messages_item_idx
        ON article_chat_messages(item_id, id);
    `,
  },
];
