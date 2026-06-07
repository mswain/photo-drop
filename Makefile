# Photo Dump — local dev stack.
#
# Infra (MiniStack S3 + Postgres) runs in Docker; the app runs on the HOST via
# `pnpm dev`. The variables below are exported into every recipe and take
# precedence over .env, so `make dev` is self-contained. Override any of them on
# the command line, e.g.  `make dev S3_BUCKET=other`.

export DATABASE_URL          ?= postgres://photo:photo@localhost:5433/photodump
export SESSION_SECRET        ?= dev-session-secret-change-me
export AWS_ACCESS_KEY_ID     ?= test
export AWS_SECRET_ACCESS_KEY ?= test
export AWS_REGION            ?= us-east-1
export S3_BUCKET             ?= photo-dump
export S3_ENDPOINT           ?= http://localhost:4566
export S3_FORCE_PATH_STYLE   ?= true

# Dev admin seeded by `make seed` / `make dev`.
ADMIN_USER ?= admin
ADMIN_PASS ?= devpassword

COMPOSE          := docker compose -f docker-compose.dev.yml
MINISTACK_HEALTH := $(S3_ENDPOINT)/_ministack/health

.DEFAULT_GOAL := help
.PHONY: help dev up down clean reset bucket migrate seed logs ps

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-9s\033[0m %s\n", $$1, $$2}'

dev: up bucket migrate seed ## Start the full dev stack and run the app (Ctrl-C stops the app)
	@echo "→ App: http://localhost:3000   Admin: $(ADMIN_USER) / $(ADMIN_PASS)"
	pnpm dev

up: ## Start MiniStack + Postgres and wait until they're ready
	$(COMPOSE) up -d
	@printf "Waiting for Postgres "; \
		i=0; until $(COMPOSE) exec -T db pg_isready -U photo -d photodump >/dev/null 2>&1; do \
			i=$$((i+1)); [ $$i -gt 60 ] && { echo " timed out"; exit 1; }; printf "."; sleep 1; done; \
		echo " ready"
	@printf "Waiting for MiniStack S3 "; \
		i=0; until curl -fsS $(MINISTACK_HEALTH) >/dev/null 2>&1; do \
			i=$$((i+1)); [ $$i -gt 120 ] && { echo " timed out"; exit 1; }; printf "."; sleep 1; done; \
		echo " ready"

down: ## Stop the dev infra (keeps the database volume)
	$(COMPOSE) down

clean: ## Stop the dev infra and delete the database volume
	$(COMPOSE) down -v

reset: clean up bucket migrate seed ## Tear everything down and rebuild a fresh dev stack

bucket: ## Create the S3 bucket in MiniStack (idempotent)
	pnpm dev:bucket

migrate: ## Apply database migrations
	pnpm db:migrate

seed: ## Create/update the dev admin (ADMIN_USER / ADMIN_PASS)
	pnpm run create-admin "$(ADMIN_USER)" "$(ADMIN_PASS)"

logs: ## Tail the dev infra logs
	$(COMPOSE) logs -f

ps: ## Show dev infra status
	$(COMPOSE) ps
