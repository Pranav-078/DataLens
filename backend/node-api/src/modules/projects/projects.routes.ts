import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import {
  getProjectSummary,
  listVersions,
  getVersionDetails,
  getTables,
  getIssues,
  getVersionRelationships,
  getVersionQualityScore,
} from "./projects.controller.js";

export const projectsRouter = Router();

projectsRouter.get("/projects/:projectId", asyncHandler(getProjectSummary));
projectsRouter.get("/projects/:projectId/versions", asyncHandler(listVersions));
projectsRouter.get("/projects/:projectId/versions/:versionId", asyncHandler(getVersionDetails));
projectsRouter.get("/projects/:projectId/versions/:versionId/tables", asyncHandler(getTables));
projectsRouter.get("/projects/:projectId/versions/:versionId/issues", asyncHandler(getIssues));
projectsRouter.get(
  "/projects/:projectId/versions/:versionId/relationships",
  asyncHandler(getVersionRelationships)
);
projectsRouter.get(
  "/projects/:projectId/versions/:versionId/quality-score",
  asyncHandler(getVersionQualityScore)
);
