.PHONY: help install install-node install-python dev down \
        test test-node test-python test-eval typecheck \
        generate-data evaluate migrate clean

help:
	@echo "DataSage — common commands"
	@echo ""
	@echo "  make install         Install all dependencies (Node + Python x3 envs)"
	@echo "  make dev             docker compose up --build (requires Docker)"
	@echo "  make down            docker compose down"
	@echo "  make migrate         Run Prisma migrations against the running db (requires Docker)"
	@echo ""
	@echo "  make test            Run every test suite (Node + Python service + evaluation harness)"
	@echo "  make test-node       Run backend-node's vitest suite"
	@echo "  make test-python     Run backend-python's pytest suite"
	@echo "  make test-eval       Run the evaluation harness's own pytest suite"
	@echo "  make typecheck       tsc --noEmit across backend-node (src + tests)"
	@echo ""
	@echo "  make generate-data   Regenerate data/clean and data/corrupted deterministically"
	@echo "  make evaluate        Run the detector evaluation harness against data/corrupted"
	@echo ""
	@echo "  make clean           Remove all generated/installed artifacts"

# ── install ──────────────────────────────────────────────────────────────

install: install-node install-python

install-node:
	cd backend-node && npm install

install-python:
	cd backend-python && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
	python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt

# ── docker ───────────────────────────────────────────────────────────────

dev:
	docker compose up --build

down:
	docker compose down

migrate:
	docker compose exec api npx prisma migrate dev --name init

# ── tests ────────────────────────────────────────────────────────────────

test: test-node test-python test-eval

test-node:
	cd backend-node && npm run test

test-python:
	cd backend-python && .venv/bin/pytest -v

test-eval:
	.venv/bin/pytest evaluation/tests/ -v

typecheck:
	cd backend-node && npx tsc -p tsconfig.json --noEmit

# ── data / evaluation ────────────────────────────────────────────────────

generate-data:
	.venv/bin/python data/generators/make_clean_data.py
	.venv/bin/python data/generators/corrupt_data.py

evaluate:
	.venv/bin/python evaluation/detector_eval.py

# ── cleanup ──────────────────────────────────────────────────────────────

clean:
	rm -rf backend-node/node_modules backend-node/dist
	rm -rf backend-python/.venv backend-python/.pytest_cache
	rm -rf .venv .pytest_cache
	rm -rf data/clean/*.csv data/corrupted/*.csv data/corrupted/ground_truth.json
	rm -rf evaluation/results/*.json
