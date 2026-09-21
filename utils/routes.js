// utils/routes.js
//
// ============================================================================
// UPDATED against the real, authenticated Swagger contract
// ============================================================================
// Source: the exported Swagger UI bundle for "Symulate-ai V1.0"
// (api.symulate.weuno.co/dev/docs), 169 documented paths, cross-checked
// against a real captured request/response (POST /organizations -> 201).
//
// Every path below is now CONFIRMED unless marked // BEST-EFFORT, which
// means: the endpoint and payload shape are confirmed from the schema, but
// the exact runtime *behaviour* (e.g. does CSV import really return
// credentials) couldn't be observed directly and needs one real run to
// fully verify. See README.md "Still open after this pass" for the full list.
//
// Every request path in the real API is prefixed /dev/api/... — API_URL
// (config/environments.js) now includes that /api segment, so routes here
// stay relative just like before.
// ============================================================================

import { API_URL } from '../config/environments.js';

export const routes = {
  // --- Auth -----------------------------------------------------------
  login: () => `${API_URL}/auth/login`, // CONFIRMED: Super Admin + Client Admin, body { email, password }
  candidateLogin: () => `${API_URL}/auth/candidate/login`, // CONFIRMED: same LoginDto (email/password) — NOT an access-token endpoint
  candidatePortalTokens: () => `${API_URL}/auth/candidate/portal-tokens`, // CONFIRMED (booking-flow-api-sequence.json + real HAR capture): the REAL candidate session type — accepts either { portalToken } from the invite link, or { candidateId, projectId } directly. sub === candidateId in the resulting JWT, unlike candidateLogin above. Booking/entry-check ONLY work against a session minted here.
  impersonateUser: () => `${API_URL}/auth/impersonate-user`, // CONFIRMED path/body { userId }; used to get a Client Admin session without a real password
  verifyImpersonateUser: () => `${API_URL}/auth/verify-impersonate-user`, // CONFIRMED path, body { token } — redeems the impersonation token from above

  // --- Health -----------------------------------------------------------
  health: () => `${API_URL}/health`, // CONFIRMED

  // --- Organizations ("Client") -------------------------------------------
  organizations: () => `${API_URL}/organizations`, // CONFIRMED via captured 201 response
  organizationsList: (page = 1, limit = 10) => `${API_URL}/organizations?page=${page}&limit=${limit}`, // CONFIRMED via project creation flow
  organizationById: (id) => `${API_URL}/organizations/${id}`, // CONFIRMED — also used to PATCH enableTalentIntelligence (see below)

  // --- Users ---------------------------------------------------------------
  currentUserProfile: () => `${API_URL}/users/user/me`, // CONFIRMED via capture (Super/Client Admin)
  currentCandidateProfile: () => `${API_URL}/users/me`, // CONFIRMED in spec (candidate profile)

  // --- Personas (needed before creating Role Play / Interview / Welcome / Board Meeting activities) ---
  personas: () => `${API_URL}/personas`, // CONFIRMED — GET list, POST create
  skills: () => `${API_URL}/skills`, // CONFIRMED via UI capture

  // --- Activities (this suite's "Task" concept maps to Activities) --------
  // CONFIRMED: there is no generic "create task with 6 types" endpoint —
  // /tasks (POST/GET) exists but only takes { title, description } and is
  // unrelated to Role Play / Interview / Case / Situation / Board Meeting /
  // Welcome. Those are a real 2-step flow:
  //   1) POST /activities/create-initial-activity  { title, type, roleLevel, duration, imageUrl, ... }
  //      type enum: ROLE_PLAY | INTERVIEW | SITUATIONS | CASE | WELCOME | BOARD_MEETING
  //   2) create/update the type-specific detail record. Role Play is patched
  //      by its nested rolePlay.id returned from create-initial-activity.
  createInitialActivity: () => `${API_URL}/activities/create-initial-activity`, // CONFIRMED
  activitiesList: (page = 1, limit = 10) => `${API_URL}/activities?page=${page}&limit=${limit}`, // CONFIRMED via project creation flow
  assignActivityToOrganizations: () => `${API_URL}/activities/assign-to-organizations`, // CONFIRMED, body { activityId, organizationIds }
  assignedActivities: (projectId, organizationId) => `${API_URL}/activities/assigned-activities?organizationId=${organizationId}&projectId=${projectId}`, // CONFIRMED — needs both organizationId + projectId query params
  scoringProjectCandidates: (projectId) => `${API_URL}/scoring/projects/${projectId}/candidates`, // CONFIRMED — returns candidates with their assigned activities per stage
  scoringProjectCandidateStages: (projectId, candidateId, page = 1, limit = 10) =>
    `${API_URL}/scoring/projects/${projectId}/candidates/stages?page=${page}&limit=${limit}&candidateId=${candidateId}`, // CONFIRMED via project review HAR
  scoringProjectCandidateActivity: (projectId, candidateId, activityId) =>
    `${API_URL}/scoring/projects/${projectId}/candidates/${candidateId}?activityId=${activityId}`, // CONFIRMED via project review HAR
  reviewProjectCandidate: (projectId, candidateId) =>
    `${API_URL}/scoring/projects/${projectId}/candidates/${candidateId}/review`, // CONFIRMED via project review HAR
  projectCandidateReviewSummary: (projectId, candidateId, stageId) =>
    `${API_URL}/scoring/projects/${projectId}/candidates/${candidateId}/summary?stageId=${stageId}`, // CONFIRMED via project review HAR
  submitProjectCandidateStageReview: (projectId, candidateId, stageId) =>
    `${API_URL}/scoring/projects/${projectId}/candidates/${candidateId}/stages/${stageId}/submit-review`, // CONFIRMED via project review HAR
  projectCandidateStageReport: (projectId, stageId, candidateId) =>
    `${API_URL}/stages/projects/${projectId}/stages/${stageId}/candidates/${candidateId}/report`, // CONFIRMED via project review HAR

  rolePlayActivities: () => `${API_URL}/role-play-activities`, // CONFIRMED from UI capture: PATCH body needs { id, personaId, scenarioDescription, ... }
  interviewActivities: () => `${API_URL}/interview-activities`, // CONFIRMED, body needs { activityId, personaId, interviewQuestions, ... }
  situationActivities: () => `${API_URL}/situation-activities`, // CONFIRMED, body is an ARRAY of { title, videoLink, activityId, ... }
  welcomeActivities: () => `${API_URL}/welcome-activities`, // CONFIRMED, body needs { activityId, personaId, welcomeMessage, ... }
  boardMeetingActivities: (activityId) => `${API_URL}/board-meeting-activities/${activityId}`, // CONFIRMED, activityId is a PATH param here (not body), body { boardMeetingPersonas }
  // BEST-EFFORT: the real "Case Exercise" type (CASE) has no dedicated
  // *-activities endpoint in the spec. It's most likely built from the
  // initial activity plus nested activity-documents / activity-mails /
  // stimuli sub-resources rather than one POST. Left as a single
  // create-initial-activity call (type: CASE) until Backend confirms the
  // rest — see README.
  activityDocuments: () => `${API_URL}/activity-documents`,
  activityMails: () => `${API_URL}/activity-mails`,
  activityContacts: () => `${API_URL}/activity-contacts`,
  bulkUpdateActivityContactDurations: () => `${API_URL}/activity-contacts/bulk-update-durations`,
  publishActivity: (activityId) => `${API_URL}/activities/${activityId}/publish`,

  // --- Projects / Candidates ---------------------------------------------
  analyzeProjectUrl: () => `${API_URL}/project/analyze-url`, // CONFIRMED via client-admin role profile flow
  createRoleProfile: () => `${API_URL}/role-profile/create`, // CONFIRMED via client-admin role profile flow
  roleProfilesList: (page = 1, limit = 10) => `${API_URL}/role-profile/get-all?page=${page}&limit=${limit}`, // CONFIRMED via project creation flow
  roleProfileById: (id) => `${API_URL}/role-profile/get/${id}`, // CONFIRMED via client-admin role profile flow
  assignRoleProfileToProject: () => `${API_URL}/role-profile/assign-to-project`, // CONFIRMED via project creation flow
  createProject: (orgId) => `${API_URL}/project/create-project/${orgId}`, // CONFIRMED, body { title, description }
  projectById: (id) => `${API_URL}/project/get-project-by-id/${id}`, // CONFIRMED
  projectAvailabilityConfig: (projectId) => `${API_URL}/projects/${projectId}/availability-config`, // CONFIRMED via project creation HAR
  candidateMyBooking: (projectId) => `${API_URL}/projects/${projectId}/bookings/my-booking`, // CONFIRMED via candidate booking HAR
  candidateBookingSlots: (projectId) => `${API_URL}/projects/${projectId}/bookings/slots`, // CONFIRMED via candidate booking HAR
  candidateBooking: (projectId) => `${API_URL}/projects/${projectId}/bookings`, // CONFIRMED, body { slotStart }
  candidateBookingEntryCheck: (projectId, currentTime) =>
    `${API_URL}/projects/${projectId}/bookings/entry-check?currentTime=${encodeURIComponent(currentTime)}`, // CONFIRMED via candidate booking HAR
  allProjects: (page = 1, limit = 10) => `${API_URL}/project/all-projects?page=${page}&limit=${limit}`, // CONFIRMED via project creation flow
  bandsList: (page = 1, limit = 10) => `${API_URL}/band/list?page=${page}&limit=${limit}`, // CONFIRMED via project creation flow
  stages: () => `${API_URL}/stages`, // CONFIRMED via project creation flow
  assignStageActivitiesBulk: () => `${API_URL}/stages/assign-activities/bulk`, // CONFIRMED via project creation flow
  uploadCandidatesCsv: (projectId) => `${API_URL}/candidate/upload-candidates?projectId=${projectId}`, // CONFIRMED legacy async queue; intentionally not used by managed provisioning because it returns no candidate IDs
  createCandidateForProject: (projectId) => `${API_URL}/candidate/create-for-project?projectId=${projectId}`, // CONFIRMED deterministic candidate creation; body { organizationId, name, email, force:false }
  candidatesByProject: (projectId, page = 1, limit = 100) => `${API_URL}/candidate/get-all-candidates-project-id/${projectId}?page=${page}&limit=${limit}`,
  projectCandidates: (projectId, page = 1, limit = 100) => `${API_URL}/project/get-candidate-by-project-id/${projectId}?page=${page}&limit=${limit}`,
  bulkAssignCandidatesToProject: (projectId) => `${API_URL}/project/assign-bulk/${projectId}`,
  assignCandidateToProject: (projectId, candidateId) => `${API_URL}/project/${projectId}/assign/${candidateId}`, // CONFIRMED
  emailTemplates: () => `${API_URL}/email-templates`, // CONFIRMED via project creation flow
  sendProjectCandidateInvitations: () => `${API_URL}/project/send-invitations-to-project-candidates`, // CONFIRMED via project creation flow

  // --- Candidate activity / response submission ---------------------------
  stimuliByActivity: (activityId) => `${API_URL}/stimuli/activity/${activityId}`, // CONFIRMED — resolves stimulusId needed by POST /responses
  startSession: () => `${API_URL}/activities/session-token`, // CONFIRMED from HAR: POST with { projectId, activityId }
  startBoardMeetingSession: (activityId, personaId, projectId) => `${API_URL}/activities/${activityId}/board-meeting/${personaId}/session-token?projectId=${projectId}`, // CONFIRMED from HAR
  startContactSession: (contactId, projectId) => `${API_URL}/activities/contacts/${contactId}/session-token?projectId=${projectId}`, // CONFIRMED from HAR
  completeSession: (id) => `${API_URL}/sessions/${id}/complete`, // LEGACY/DO NOT USE in current dev: runtime returned 404. Use updateActivityStatus(activityId) -> COMPLETED for session/activity cleanup.
  submitResponse: () => `${API_URL}/responses`, // CONFIRMED, body { activityId, stimulusId, userId, responseType, content, transcript?, timestamp? }
  updateActivityStatus: (activityId) => `${API_URL}/activities/candidate-activity/update-status/${activityId}`, // CONFIRMED from HAR: PATCH { status, projectId, endedAt }
  uploadCandidateActivityFile: (activityId) => `${API_URL}/activities/candidate-activity/${activityId}/upload-files`, // CONFIRMED from HAR

  // --- Candidate agreement / onboarding -----------------------------------------
  acceptAgreement: (candidateId, projectId) => `${API_URL}/candidate/update-for-project/${candidateId}?projectId=${projectId}`, // CONFIRMED — PATCH { isAgreementPolicyAccepted: true }

  // --- Dashboard (used for read-only "background load" checks) ------------
  dashboardOverview: () => `${API_URL}/dashboard/overview` // CONFIRMED via capture
};

export default routes;