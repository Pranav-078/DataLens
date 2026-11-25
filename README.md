# DataLens

DataLens is a multi-table CSV data quality and schema intelligence application. It is organized as a React frontend, a Node.js API, and a Python profiling engine.

## Repository structure

```text
DataLens/
├── frontend/                 # React + Vite application (frontend work goes here)
├── backend/
│   ├── node-api/             # Express + TypeScript API, Prisma and PostgreSQL
│   └── python-engine/        # FastAPI profiler and relationship inference engine
├── data/                     # Data generators and development data
├── fixtures/                 # Sample CSV versions and ground-truth fixtures
├── docs/                     # Architecture and technical documentation
├── evaluation/               # Detector evaluation harness and tests
├── archive/                  # Historical phase snapshots; not used at runtime
├── docker-compose.yml
├── Makefile
└── .env.example
```

## Technology

- Frontend: React and Vite (to be implemented)
- API: Node.js, Express, TypeScript
- Profiling: Python, FastAPI, pandas
- Database: PostgreSQL with pgvector, managed through Prisma
- Local orchestration: Docker Compose

## Getting started

1. Install Node.js 20+, Python 3.11+, and Docker Desktop.
2. Copy the environment template:

   ```bash
   cp .env.example .env
   ```

3. Install backend dependencies:

   ```bash
   make install
   ```

4. Start the services:

   ```bash
   make dev
   ```

5. Check service health:

   - Node API: http://localhost:8000/health
   - Node readiness: http://localhost:8000/health/ready
   - Python engine: http://localhost:8001/health

See `docs/architecture.md` and the backend READMEs for implementation details.

## Current implementation notes

- The integrated backend and profiling engine are retained from the previous `DataSage/` application folder.
- The Python relationship inference module and its endpoint are present. The Node upload/persistence pipeline still needs to be wired to that endpoint before relationships are available end-to-end through the public API.
- The frontend directory is a clean starting point; the React application has not yet been scaffolded.
- Historical phase folders are preserved under `archive/` for reference. They are not active application code.

## Development commands

```bash
make install
make dev
make test
make typecheck
make down
```
