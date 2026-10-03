import { defineConfig } from "drizzle-kit";
import path from "path";
import { assertOperatorConfiguration, assertPublicOperatorSchema } from "../../artifacts/api-server/src/lib/product-identity";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// Schema inspection/push is an operator entrypoint too; never accept an unbound remote database or a runtime-only role.
assertOperatorConfiguration();
assertPublicOperatorSchema();

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts").replaceAll("\\", "/"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
