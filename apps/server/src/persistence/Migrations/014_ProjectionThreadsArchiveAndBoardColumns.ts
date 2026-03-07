import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN archived_at TEXT
  `.pipe(Effect.orElseSucceed(() => undefined));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN board_column TEXT NOT NULL DEFAULT 'inbox'
  `.pipe(Effect.orElseSucceed(() => undefined));

  yield* sql`
    UPDATE projection_threads
    SET board_column = 'inbox'
    WHERE board_column IS NULL OR TRIM(board_column) = ''
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_archived_at
    ON projection_threads(archived_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_board_column
    ON projection_threads(board_column)
  `;
});
