import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";

const migrationsLayer = it.layer(Layer.provideMerge(Layer.empty, SqlitePersistenceMemory));

migrationsLayer("Migrations", (it) => {
  it.effect("adds archive and board columns to projection_threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly name: string;
        readonly dfltValue: string | null;
      }>`
        SELECT
          name,
          dflt_value AS "dfltValue"
        FROM pragma_table_info('projection_threads')
        WHERE name IN ('archived_at', 'board_column')
        ORDER BY name ASC
      `;

      assert.deepEqual(rows, [
        {
          name: "archived_at",
          dfltValue: null,
        },
        {
          name: "board_column",
          dfltValue: "'inbox'",
        },
      ]);
    }),
  );
});
