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
- AI: Gemini, PostgreSQL pgvector, PostgreSQL full-text search and hybrid RAG
- Local orchestration: Docker Compose

## Run the application locally

### 1. Configure environment

Copy the root environment template:

```bash
cp .env.example .env
```

The Docker Compose `DATABASE_URL` must use the service hostname `db:5432`, not `localhost`. The published host port is only for tools running directly on your computer.

To enable account registration and sign-in, set these values in the root `.env` file:

```dotenv
AUTH_ENABLED=true
AUTH_ALLOW_REGISTRATION=true
AUTH_COOKIE_SECRET=<random-secret-at-least-32-characters>
```

Generate a private random secret locally and never commit or share the `.env` file. See [docs/authentication.md](docs/authentication.md) for the full setup and security notes. Authentication is disabled by default for local preview environments.

Add `GEMINI_API_KEY` to the root `.env` to use Gemini-powered document indexing and AI chat. Keep provider credentials on the server; never expose them through frontend environment variables.

### 2. Start backend services

From the repository root:

```bash
docker compose up --build
```

The services are:
- Node API: http://localhost:8000
- Python profiler: http://localhost:8001
- PostgreSQL: the host port configured in `docker-compose.yml`

Check API liveness at http://localhost:8000/health and readiness at http://localhost:8000/health/ready.

### 3. Start frontend

Open a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Vite proxies frontend API requests from `/api` to the Node API at `http://localhost:8000`.

## Main application capabilities

- Multi-file CSV upload, validation and profiling.
- Column statistics, data quality issues and quality scoring.
- Dataset version history and structural schema-drift comparison.
- Cross-table relationship inference with confidence, overlap and orphan evidence.
- Relationship Graph View, Table View and an evidence inspector.
- Account registration and sign-in with hashed passwords and signed HttpOnly session cookies when authentication is enabled.
- A private default workspace for each newly registered account.
- Project-scoped document indexing and AI chat using hybrid vector and keyword retrieval, optional reranking, read-only dataset tools and source citations.

## Frontend-to-backend flow

- API readiness: `GET /health/ready`
- CSV upload and profiling: `POST /uploads/validate` (multipart field `files`, with the signed-in user's workspace `projectId`)
- Project metadata: `GET /projects/:projectId` and `GET /projects/:projectId/versions`
- Version data: tables, issues, relationships and quality score endpoints under `/projects/:projectId/versions/:versionId`
- Knowledge document indexing: `POST /projects/:projectId/knowledge`
- AI chat: `POST /projects/:projectId/ai/chat` or `POST /projects/:projectId/ai/chat/stream`
- Node orchestrates persistence and calls the Python profiler at `POST /internal/profile/tables`. Python performs profiling and relationship inference; Node persists the returned results in PostgreSQL.

## Current limitations and production considerations

- A dedicated project-management interface for creating, renaming and transferring multiple projects is not currently available. Registration creates a default personal workspace.
- Existing projects created before account registration remain unowned legacy projects. They are not automatically assigned to the first registered user; see [docs/authentication.md](docs/authentication.md).
- The frontend stores the active project and dataset-version selection in browser local storage. These IDs are not authorization credentials; the API must enforce authentication and project ownership on every protected request.
- Email verification, password reset/recovery, multi-factor authentication, organization roles, invitations and audit-log screens are not implemented.
- The current IP-based authentication limiter is held in API process memory and resets when the API restarts. A shared rate-limit store is needed for multi-instance deployments.
- Production deployment requires HTTPS, secure cookie settings, monitoring, a shared rate limiter where applicable, and a security review. Do not expose the local preview mode with `AUTH_ENABLED=false` to the public internet.
- RAG citations and similarity scores are evidence aids, not guarantees of correctness. Verify important conclusions against the source documents and dataset.

## Tests and maintenance

From the repository root:

```bash
make test
make typecheck
```

For Node API tests and build checks:

```bash
cd backend/node-api
npm test
npm run build
```

See [docs/architecture.md](docs/architecture.md), [docs/authentication.md](docs/authentication.md) and [backend/node-api/src/modules/ai/README.md](backend/node-api/src/modules/ai/README.md) for architecture, account security and RAG implementation details. Historical phase snapshots are kept under `archive/` for reference and are not part of the active runtime.
