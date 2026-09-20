-- Inbox de equipo (Fases A–C): ownership, autor tipado, support ack,
-- notas internas y canned replies.
-- Ejecutar manualmente en Postgres (este repo no migra al arrancar).

ALTER TABLE conversation
  ADD COLUMN IF NOT EXISTS assigned_business_user_id uuid,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS support_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS support_acked_at timestamptz,
  ADD COLUMN IF NOT EXISTS support_acked_by_business_user_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_assigned_business_user_id_fkey'
  ) THEN
    ALTER TABLE conversation
      ADD CONSTRAINT conversation_assigned_business_user_id_fkey
      FOREIGN KEY (assigned_business_user_id) REFERENCES business_user(id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_support_acked_by_business_user_id_fkey'
  ) THEN
    ALTER TABLE conversation
      ADD CONSTRAINT conversation_support_acked_by_business_user_id_fkey
      FOREIGN KEY (support_acked_by_business_user_id) REFERENCES business_user(id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversation_assigned_open
  ON conversation (business_id, assigned_business_user_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_conversation_support_pending
  ON conversation (business_id, support_requested_at)
  WHERE support_acked_at IS NULL;

ALTER TABLE conversation_message
  ADD COLUMN IF NOT EXISTS sent_by_user_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_message_sent_by_user_id_fkey'
  ) THEN
    ALTER TABLE conversation_message
      ADD CONSTRAINT conversation_message_sent_by_user_id_fkey
      FOREIGN KEY (sent_by_user_id) REFERENCES "user"(id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS conversation_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  business_id uuid NOT NULL REFERENCES business(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  body text NOT NULL,
  created_by_business_user_id uuid NOT NULL REFERENCES business_user(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_note_conv_created
  ON conversation_note (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS canned_reply (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES business(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  title varchar(120) NOT NULL,
  body text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canned_reply_business_position
  ON canned_reply (business_id, position);
