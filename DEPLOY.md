# Deploy & Schema Workflow (production)

## Standard deploy
```bash
cd /var/www/zipto-backend
git pull origin main
npm install
npm run build
./scripts/db-migrate.sh          # idempotent — applies migration_production.sql
pm2 restart <app-name> --update-env
```
`scripts/db-migrate.sh` reads the `DATABASE_*` values from `.env`, so you never
retype psql credentials.

---

## Turning OFF `DATABASE_SYNCHRONIZE` (recommended hardening)

`DATABASE_SYNCHRONIZE=true` makes TypeORM auto-alter the live schema to match the
entities on every boot. Convenient, but dangerous in production: a renamed/removed
entity field can silently **drop a column and its data**. The safe model is
`synchronize=false` + explicit migrations.

### One-time cutover (do it in this exact order)

1. **Make sure the live schema already matches the entities.** With synchronize
   currently `true`, deploy the latest code once (build + restart). That boot
   syncs any pending columns (e.g. `cf_terminal_id`). Confirm the column you
   expect exists:
   ```bash
   PGPASSWORD='<pw>' psql -h localhost -U <user> -d <db> -c "\d driver_profiles" | grep cf_terminal_id
   ```

2. **Snapshot the schema as a recovery baseline** (structure only, no data) and
   commit it, so a fresh DB can always be rebuilt:
   ```bash
   PGPASSWORD='<pw>' pg_dump -h localhost -U <user> -d <db> \
     --schema-only --no-owner --no-privileges -f schema_baseline.sql
   ```

3. **Flip the flag and restart:**
   ```bash
   sed -i 's/^DATABASE_SYNCHRONIZE=.*/DATABASE_SYNCHRONIZE=false/' .env
   pm2 restart <app-name> --update-env
   ```

4. Smoke-test the app (login, a booking, the rider QR). Done — schema is now
   frozen and only changes when you run a migration.

### Going forward — how to make a schema change
1. Edit the entity in code as usual.
2. Add an **idempotent** statement to `migration_production.sql`, e.g.:
   ```sql
   ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <col> <type>;
   -- or: CREATE TABLE IF NOT EXISTS ...   /  CREATE TYPE ... (wrapped in DO $$ ... duplicate_object)
   ```
3. Deploy with the standard steps above — `./scripts/db-migrate.sh` applies it.

> Keep every statement in `migration_production.sql` idempotent (`IF NOT EXISTS`,
> `duplicate_object` guards) so it's always safe to re-run on every deploy.

### Rollback
If a deploy misbehaves, `synchronize=false` means the schema didn't change on its
own — you only changed what your migration did. Revert the code/migration and
redeploy.
