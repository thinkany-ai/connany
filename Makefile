.PHONY: dev db

# Start local PostgreSQL, apply migrations, then run the server with hot reload.
# Docker is only started when DATABASE_URL points at the compose database (port 54329).
dev: node_modules/.package-lock.json .env
	@if grep -q '^DATABASE_URL=.*:54329/' .env; then $(MAKE) --no-print-directory db; fi
	npm run db:migrate
	npm run dev

db:
	docker compose up -d --wait postgres

node_modules/.package-lock.json: package-lock.json
	npm ci

.env:
	npm run setup
