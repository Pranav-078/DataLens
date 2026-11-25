# DataLens

DataLens is a multi-table CSV data quality and schema intelligence application. The active application is maintained in one repository structure: React frontend, Node.js API, Python profiling engine, PostgreSQL metadata store and evaluation assets.

## Repository structure

```text
DataLens/
├── frontend/                 # React + Vite user interface
├── backend/
│   ├── node-api/             # Express + TypeScript API, Prisma and PostgreSQL
│   └── python-engine/        # FastAPI profiler and relationship inference
├── data/                     # Data generators
├── fixtures/                 # Sample CSV versions and ground-truth fixtures
├── docs/                     # Architecture and technical documentation
├── evaluation/               # Detector evaluation harness and tests
├── archive/                  # Historical phase snapshots; not used at runtime
├── docker-compose.yml
├── Makefile
└── .env.example
```

## Technology

- Frontend: React, Vite, React Router, Axios and Lucide
- API: Node.js, Express, TypeScript and Prisma
- Profiling: Python, FastAPI, pandas and the DataSage profiler
- Database: PostgreSQL with pgvector
- Local orchestration: Docker Compose

## Run the application locally

### 1. Configure environment

Copy the root environment template:

```bash
cp .env.example .env
```

The Docker Compose DATABASE_URL must use the service hostname `db:5432`, not `localhost:5433`. The host port 5433 is only for tools running directly on your computer.

### 2. Start backend services

From the repository root:

```bash
docker compose up --build
```

The services are:
- Node API: http://localhost:8000
- Python profiler: http://localhost:8001
- PostgreSQL: localhost:5433 (host access)

Check API liveness at http://localhost:8000/health and readiness at http://localhost:8000/health/ready.

### 3. Start frontend

Open a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Vite proxies frontend API requests from `/api` to the Node API at `http://localhost:8000`.

## Frontend-to-backend flow

- API readiness: `GET /health/ready`
- CSV upload and profiling: `POST /uploads/validate` (multipart field `files`, optional `projectId`)
- Project metadata: `GET /projects/:projectId` and `GET /projects/:projectId/versions`
- Version data: tables, issues, relationships and quality score endpoints under `/projects/:projectId/versions/:versionId`
- Node orchestrates persistence and calls the Python profiler at `POST /internal/profile/tables`. Python performs profiling and relationship inference; Node persists the returned results in PostgreSQL.

## Current limitations

- The login screen is a frontend preview gate, not real authentication. Do not use it to protect production data.
- Projects are currently created automatically by the first upload; there is no dedicated project-creation UI/API yet.
- The frontend currently stores the active project and version IDs in browser local storage.
- RAG and agentic AI are roadmap capabilities, not implemented features.

## Tests and maintenance

```bash
make test
make typecheck
``

See `docs/architecture.md` for the system design. Historical phase snapshots are kept under `archive/` for reference and are not part of the active runtime.
