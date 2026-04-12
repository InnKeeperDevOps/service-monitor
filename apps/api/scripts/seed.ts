import { ensureCoreSchema } from "../../../packages/db/src/index.js";
import { hashPassword } from "../src/auth.js";
import pg from "pg";
import crypto from "node:crypto";

const { Pool } = pg;

async function seed() {
  console.log("Ensuring schema...");
  const pool = new Pool({ connectionString: "postgres://postgres:postgres@127.0.0.1:5001/service_monitor" });
  
  try {
    await ensureCoreSchema(pool);

    const res = await pool.query("SELECT id FROM users WHERE email = $1", ["test@example.com"]);
    if (res.rows.length > 0) {
      console.log("User test@example.com already exists");
      process.exit(0);
    }

    const tenantId = `t-${crypto.randomUUID()}`;
    await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, "Default Tenant"]);
    
    const userId = `u-${crypto.randomUUID()}`;
    const pwdHash = await hashPassword("mypassword123");
    await pool.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [userId, "test@example.com", pwdHash]);
    
    await pool.query("INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)", [tenantId, userId, "owner"]);
    
    console.log("Successfully created user test@example.com with password mypassword123");
  } catch (err) {
    console.error("Error seeding database:", err);
  } finally {
    await pool.end();
  }
}

seed();