import { Pool } from 'pg';
import { loadConfig, loadLocalEnvFile } from '../src/config.js';
import { hashPassword } from '../src/portal/passwords.js';

// Creates (or resets) the first super admin. The password comes from the environment so it never
// lands in shell history or a process listing:
//   AVC_SUPER_ADMIN_PASSWORD=... pnpm create:super-admin you@example.com "Your Name"
async function main(): Promise<void> {
  loadLocalEnvFile();
  const [email, name] = process.argv.slice(2);
  const password = process.env.AVC_SUPER_ADMIN_PASSWORD;
  if (!email || !name || !password || password.length < 10) {
    console.error(
      'Usage: AVC_SUPER_ADMIN_PASSWORD=<10+ chars> pnpm create:super-admin <email> "<display name>"',
    );
    process.exitCode = 1;
    return;
  }
  const pool = new Pool({ connectionString: loadConfig().DATABASE_URL });
  try {
    await pool.query(
      `INSERT INTO avc.staff_members(external_subject, display_name, email, role, password_hash, must_change_password)
       VALUES ('local:' || gen_random_uuid(), $1, lower($2), 'super_admin', $3, true)
       ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO UPDATE
         SET role = 'super_admin', active = true, password_hash = EXCLUDED.password_hash,
             must_change_password = true, failed_attempts = 0, locked_until = NULL`,
      [name, email, await hashPassword(password)],
    );
    console.log(
      `Super admin ready: ${email.toLowerCase()} (password change required at first sign-in)`,
    );
  } finally {
    await pool.end();
  }
}

void main();
