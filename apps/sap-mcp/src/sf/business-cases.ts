/**
 * Business cases: the top read scenarios of each SuccessFactors module, ported
 * from the business-case library of the SuccessFactors MCP server. A case names
 * one entity and, at most, one value the user supplies; nothing else about the
 * request can be chosen by a model.
 *
 * Entity and field names come from the SuccessFactors API reference and are a
 * starting point, not a guarantee: modules that are not licensed, template-
 * specific entities and renamed fields differ between tenants. A case therefore
 * reads without naming its fields (except where a field would be large or
 * binary) and shows what the tenant returns. When a filter field is wrong for a
 * tenant, the case can be run again with other filters after `sf_describeEntity`.
 */

export const CASE_MODULES = [
  'Employee Central',
  'Common Entities',
  'Recruiting',
  'Performance and Goals',
  'Learning',
  'Onboarding',
  'Succession and Development',
  'Job Profile Builder',
  'Compensation',
  'Calibration',
  'Employee Profile',
  'Execution Manager',
  'Success Store',
] as const;
export type CaseModule = (typeof CASE_MODULES)[number];

export interface CaseInput {
  /** What the user is asked for: "Employee user id". */
  label: string;
  /** The field the value is compared with. */
  field: string;
  kind: 'text' | 'number' | 'since';
  /** Without a value, the case runs for the calling user. */
  defaultsToCaller?: boolean;
}

export interface BusinessCase {
  id: string;
  module: CaseModule;
  title: string;
  summary: string;
  entity: string;
  input?: CaseInput;
  orderBy?: { field: string; direction: 'asc' | 'desc' };
  /** Named only where reading every field would return binary or very large content. */
  select?: string[];
  /** Columns shown first when the tenant returns them. */
  columns?: string[];
  /** Why the case cannot run in this deployment. */
  unavailable?: string;
}

const user = (field = 'userId'): CaseInput => ({ label: 'Employee user id', field, kind: 'text', defaultsToCaller: true });
const id = (label: string, field: string, kind: CaseInput['kind'] = 'number'): CaseInput => ({ label, field, kind });
const LEARNING = 'Learning uses its own API (the Learning OData services), which the SuccessFactors destination of this workspace does not reach.';

export const BUSINESS_CASES: BusinessCase[] = [
  // Employee Central
  { id: 'ec-01', module: 'Employee Central', title: 'Current job information', summary: 'The job records of an employee: position, department, manager and status.', entity: 'EmpJob', input: user(), orderBy: { field: 'startDate', direction: 'desc' }, columns: ['userId', 'startDate', 'jobTitle', 'position', 'department', 'division', 'location', 'company', 'managerId', 'emplStatus'] },
  { id: 'ec-02', module: 'Employee Central', title: 'Direct reports of a manager', summary: 'Employees whose job record names the manager.', entity: 'EmpJob', input: user('managerId'), columns: ['userId', 'jobTitle', 'department', 'location', 'startDate', 'managerId'] },
  { id: 'ec-03', module: 'Employee Central', title: 'Job changes since a date', summary: 'Job records changed on or after a date.', entity: 'EmpJob', input: { label: 'Date (YYYY-MM-DD); the last 7 days when left out', field: 'lastModifiedDateTime', kind: 'since' }, orderBy: { field: 'lastModifiedDateTime', direction: 'desc' }, columns: ['userId', 'startDate', 'jobTitle', 'department', 'event', 'eventReason', 'lastModifiedDateTime'] },
  { id: 'ec-04', module: 'Employee Central', title: 'Recurring pay components', summary: 'Base pay and other recurring pay components of an employee.', entity: 'EmpPayCompRecurring', input: user(), columns: ['userId', 'payComponent', 'paycompvalue', 'currencyCode', 'frequency', 'startDate', 'endDate'] },
  { id: 'ec-05', module: 'Employee Central', title: 'One-time payments', summary: 'Non-recurring payments of an employee, such as bonuses.', entity: 'EmpPayCompNonRecurring', input: user(), columns: ['userId', 'payComponentCode', 'value', 'currencyCode', 'payDate'] },

  // Common Entities
  { id: 'ce-01', module: 'Common Entities', title: 'Values of a picklist', summary: 'The options of one picklist with their codes and labels.', entity: 'PickListValueV2', input: id('Picklist id', 'PickListV2_id', 'text'), columns: ['PickListV2_id', 'externalCode', 'label_defaultValue', 'status'] },
  { id: 'ce-02', module: 'Common Entities', title: 'Permission roles', summary: 'The role-based permission roles defined in the tenant.', entity: 'RBPRole', columns: ['roleId', 'roleName', 'roleDesc', 'userType', 'lastModifiedDate'] },
  { id: 'ce-03', module: 'Common Entities', title: 'Dynamic groups', summary: 'Permission and other dynamic groups with their member counts.', entity: 'DynamicGroup', columns: ['groupID', 'groupName', 'groupType', 'activeMembershipCount', 'totalMemberCount'] },
  { id: 'ce-04', module: 'Common Entities', title: 'Attachment details', summary: 'Name, type and size of one attachment. The file itself is not read.', entity: 'Attachment', input: id('Attachment id', 'attachmentId'), select: ['attachmentId', 'fileName', 'mimeType', 'fileSize', 'module', 'createdDate'] },
  { id: 'ce-05', module: 'Common Entities', title: 'Photos on record', summary: 'Which photos an employee has on record. The image itself is not read.', entity: 'Photo', input: user(), select: ['userId', 'photoType', 'mimeType', 'width', 'height', 'lastModifiedDateTime'] },
  { id: 'ce-06', module: 'Common Entities', title: 'To-do items (inbox) of an employee', summary: 'What is waiting in the to-do list of an employee: approvals, forms and other tasks.', entity: 'TodoEntryV2', input: user(), columns: ['todoEntryId', 'todoEntryName', 'categoryLabel', 'categoryId', 'status', 'dueDate', 'createdDate', 'subjectId'] },

  // Recruiting
  { id: 'rcm-01', module: 'Recruiting', title: 'Job requisitions', summary: 'The job requisitions the user may see.', entity: 'JobRequisition', columns: ['jobReqId', 'internalStatus', 'numberOpenings', 'department', 'location', 'jobStartDate', 'createdDateTime'] },
  { id: 'rcm-02', module: 'Recruiting', title: 'Postings of a requisition', summary: 'Where and when a job requisition is posted.', entity: 'JobRequisitionPosting', input: id('Job requisition id', 'jobReqId'), columns: ['jobPostingId', 'jobReqId', 'boardId', 'postingStatus', 'postStartDate', 'postEndDate'] },
  { id: 'rcm-03', module: 'Recruiting', title: 'Applications for a requisition', summary: 'The candidates who applied for a job requisition.', entity: 'JobApplication', input: id('Job requisition id', 'jobReqId'), columns: ['applicationId', 'candidateId', 'jobReqId', 'firstName', 'lastName', 'applicationDate', 'lastModifiedDateTime'] },
  { id: 'rcm-04', module: 'Recruiting', title: 'Status history of an application', summary: 'Every status an application went through.', entity: 'JobApplicationStatusAuditTrail', input: id('Application id', 'applicationId'), columns: ['applicationId', 'revNumber', 'skippedStatus', 'createdDateTime', 'lastModifiedDateTime'] },
  { id: 'rcm-05', module: 'Recruiting', title: 'Candidate profile', summary: 'The profile of one candidate.', entity: 'Candidate', input: id('Candidate id', 'candidateId'), columns: ['candidateId', 'firstName', 'lastName', 'primaryEmail', 'country', 'city', 'creationDateTime'] },

  // Performance and Goals
  { id: 'pmg-01', module: 'Performance and Goals', title: 'Performance forms of an employee', summary: 'The performance review forms with their status and rating.', entity: 'FormHeader', input: user('formSubjectId'), columns: ['formDataId', 'formTemplateId', 'formTitle', 'formDataStatus', 'formReviewStartDate', 'formReviewEndDate', 'rating'] },
  { id: 'pmg-02', module: 'Performance and Goals', title: 'Content of a form', summary: 'The content records of one performance form.', entity: 'FormContent', input: id('Form id (formDataId)', 'formDataId'), columns: ['formContentId', 'formDataId', 'status', 'lastModifiedDate'] },
  { id: 'pmg-03', module: 'Performance and Goals', title: 'Goals on a form', summary: 'The objectives rated on one performance form.', entity: 'FormObjective', input: id('Form id (formDataId)', 'formDataId'), columns: ['formDataId', 'itemId', 'name', 'metric', 'weight', 'state'] },
  { id: 'pmg-04', module: 'Performance and Goals', title: 'Competencies on a form', summary: 'The competencies rated on one performance form.', entity: 'FormCompetency', input: id('Form id (formDataId)', 'formDataId'), columns: ['formDataId', 'itemId', 'name', 'description', 'weight'] },
  { id: 'pmg-05', module: 'Performance and Goals', title: 'Overall rating summary of a form', summary: 'The calculated and manual overall ratings of one performance form.', entity: 'FormObjCompSummarySection', input: id('Form id (formDataId)', 'formDataId'), columns: ['formDataId', 'sectionName', 'sectionDescription'] },

  // Learning
  { id: 'lms-01', module: 'Learning', title: 'Learning history', summary: 'Completed learning of an employee.', entity: 'userlearning-service', unavailable: LEARNING },
  { id: 'lms-02', module: 'Learning', title: 'Learning plan', summary: 'Assigned learning with due dates.', entity: 'learningplan-service', unavailable: LEARNING },
  { id: 'lms-03', module: 'Learning', title: 'Assign or unassign learning', summary: 'Changes the learning assignments of an employee.', entity: 'userassignment-service', unavailable: LEARNING },
  { id: 'lms-04', module: 'Learning', title: 'Curricula', summary: 'Curricula and their requirements.', entity: 'curriculum-service', unavailable: LEARNING },
  { id: 'lms-05', module: 'Learning', title: 'Learning catalog', summary: 'Courses and other items in the catalog.', entity: 'catalog-service', unavailable: LEARNING },

  // Onboarding
  { id: 'onb-01', module: 'Onboarding', title: 'Onboarding processes', summary: 'The onboarding processes the user may see, with their status.', entity: 'ONB2Process', columns: ['processId', 'processStatus', 'processType', 'user', 'targetDate', 'startDate', 'lastModifiedDateTime'] },
  { id: 'onb-02', module: 'Onboarding', title: 'New-hire data', summary: 'The data collected for one onboarding candidate.', entity: 'OnboardingCandidateInfo', input: id('Candidate id', 'candidateId', 'text'), columns: ['candidateId', 'fName', 'lName', 'hireDate', 'jobReqId', 'managerId'] },
  { id: 'onb-03', module: 'Onboarding', title: 'Equipment of an onboarding process', summary: 'The equipment requested for a new hire.', entity: 'ONB2EquipmentActivity', input: id('Onboarding process id', 'process', 'text'), columns: ['activityId', 'process', 'activityStatus', 'dueDate', 'responsibleUsers'] },
  { id: 'onb-04', module: 'Onboarding', title: 'Goals of an onboarding process', summary: 'The goals set for a new hire.', entity: 'OnboardingGoalActivity', input: id('Onboarding process id', 'process', 'text'), columns: ['activityId', 'process', 'activityStatus', 'dueDate'] },
  { id: 'onb-05', module: 'Onboarding', title: 'Meetings of an onboarding process', summary: 'The meetings scheduled for a new hire.', entity: 'OnboardingMeetingActivity', input: id('Onboarding process id', 'process', 'text'), columns: ['activityId', 'process', 'activityStatus', 'dueDate'] },

  // Succession and Development
  { id: 'scd-01', module: 'Succession and Development', title: 'Development goals', summary: 'The development goals of an employee.', entity: 'DevGoal', input: user(), columns: ['id', 'userId', 'name', 'status', 'due', 'state'] },
  { id: 'scd-02', module: 'Succession and Development', title: 'Development goal permissions', summary: 'What the user may do with the development goals of an employee.', entity: 'DevGoalPermission', input: user(), columns: ['userId', 'view', 'create', 'edit', 'delete'] },
  { id: 'scd-03', module: 'Succession and Development', title: 'Certifications', summary: 'The learning certifications linked to the development of an employee.', entity: 'DevLearningCertifications', input: user(), columns: ['userId', 'name', 'status', 'startDate', 'endDate'] },
  { id: 'scd-04', module: 'Succession and Development', title: 'Mentoring matches', summary: 'The mentor and mentee pairs of one mentoring program.', entity: 'MentoringProgramMatchedParticipant', input: id('Mentoring program id', 'MentoringProgram_externalCode', 'text'), columns: ['MentoringProgram_externalCode', 'mentor', 'mentee', 'matchedStatus'] },
  { id: 'scd-05', module: 'Succession and Development', title: 'Successors of a position', summary: 'The employees nominated as successors, with their readiness.', entity: 'Successor', input: id('Position code', 'nominationTarget', 'text'), columns: ['id', 'userId', 'readiness', 'rank', 'status', 'note'] },

  // Job Profile Builder
  { id: 'jpb-01', module: 'Job Profile Builder', title: 'Job profiles', summary: 'The job profiles defined in the tenant.', entity: 'JobProfile', columns: ['externalCode', 'name_defaultValue', 'status', 'lastModifiedDateTime'] },
  { id: 'jpb-02', module: 'Job Profile Builder', title: 'Competency library', summary: 'The competencies available for job profiles.', entity: 'CompetencyEntity', columns: ['externalCode', 'name_defaultValue', 'libName_defaultValue', 'category_defaultValue', 'status'] },
  { id: 'jpb-03', module: 'Job Profile Builder', title: 'Skills library', summary: 'The skills available for job profiles.', entity: 'SkillEntity', columns: ['externalCode', 'name_defaultValue', 'libName_defaultValue', 'category_defaultValue', 'status'] },
  { id: 'jpb-04', module: 'Job Profile Builder', title: 'Job roles', summary: 'The job roles and the families they belong to.', entity: 'RoleEntity', columns: ['externalCode', 'name_defaultValue', 'status', 'lastModifiedDateTime'] },
  { id: 'jpb-05', module: 'Job Profile Builder', title: 'Competencies of a role', summary: 'The competencies and behaviors mapped to one job role.', entity: 'RoleCompetencyBehaviorMappingEntity', input: id('Job role code', 'RoleEntity_externalCode', 'text'), columns: ['RoleEntity_externalCode', 'externalCode', 'rating', 'weight'] },

  // Compensation
  { id: 'cmp-01', module: 'Compensation', title: 'Spot award programs', summary: 'The spot award programs with their status.', entity: 'SpotAwardProgram', columns: ['externalCode', 'externalName', 'active', 'startDate', 'endDate'] },
  { id: 'cmp-02', module: 'Compensation', title: 'Spot awards of an employee', summary: 'The spot awards an employee received.', entity: 'SpotAward', input: user('userId'), columns: ['externalCode', 'userId', 'awardAmount', 'currency', 'status', 'awardedDate'] },
  { id: 'cmp-03', module: 'Compensation', title: 'Award levels', summary: 'The award levels with their amounts.', entity: 'SpotAwardLevel', columns: ['externalCode', 'externalName', 'totalAmount', 'currency'] },
  { id: 'cmp-04', module: 'Compensation', title: 'Award eligibility rules', summary: 'Who is eligible for the spot award programs.', entity: 'SpotAwardEligibilityRule', columns: ['externalCode', 'ruleDescription', 'eligibilityRule'] },
  { id: 'cmp-05', module: 'Compensation', title: 'Award budgets', summary: 'The budgets of the spot award programs and what is left of them.', entity: 'SpotAwardBudget', columns: ['externalCode', 'budgetHolder', 'budgetAmount', 'remainingBudget', 'currency'] },

  // Calibration
  { id: 'cal-01', module: 'Calibration', title: 'Calibration sessions', summary: 'The calibration sessions the user may see.', entity: 'CalibrationSession', columns: ['sessionId', 'sessionName', 'status', 'sessionDate', 'sessionLocation'] },
  { id: 'cal-02', module: 'Calibration', title: 'Subjects of a session', summary: 'The employees calibrated in one session.', entity: 'CalibrationSessionSubject', input: id('Session id', 'sessionId'), columns: ['sessionSubjectId', 'sessionId', 'userId', 'status', 'calibratedFlag'] },
  { id: 'cal-03', module: 'Calibration', title: 'Calibrated ratings', summary: 'The ratings given in one calibration session.', entity: 'CalibrationSubjectRank', input: id('Session subject id', 'subjectId'), columns: ['subjectRankId', 'subjectId', 'ratingType', 'rating', 'calcRating'] },
  { id: 'cal-04', module: 'Calibration', title: 'Calibration comments', summary: 'The comments recorded for a session subject.', entity: 'CalibrationSubjectComment', input: id('Session subject id', 'subjectId'), columns: ['commentId', 'subjectId', 'comments', 'createdBy', 'createdDate'] },
  { id: 'cal-05', module: 'Calibration', title: 'Rating distribution', summary: 'All calibrated ratings, ordered, to check their distribution.', entity: 'CalibrationSubjectRank', orderBy: { field: 'rating', direction: 'desc' }, columns: ['subjectId', 'ratingType', 'rating', 'calcRating'] },

  // Employee Profile
  { id: 'ep-01', module: 'Employee Profile', title: 'Public profile', summary: 'What an employee shows on their public profile.', entity: 'EPPublicProfile', input: user(), columns: ['userId', 'aboutMeText', 'aboutMeTags', 'iceBreaker'] },
  { id: 'ep-02', module: 'Employee Profile', title: 'Badges of an employee', summary: 'The badges an employee received.', entity: 'UserBadges', input: user(), columns: ['badgeInstanceId', 'userId', 'badgeTitle', 'comment', 'badgeCreatorName', 'createdDate'] },
  { id: 'ep-03', module: 'Employee Profile', title: 'Badge catalog', summary: 'The badges that can be awarded.', entity: 'BadgeTemplates', columns: ['badgeTemplateId', 'title', 'description'] },

  // Execution Manager
  { id: 'em-01', module: 'Execution Manager', title: 'Integration events', summary: 'The latest events of monitored integrations and jobs.', entity: 'EMEvent', columns: ['id', 'process', 'eventType', 'eventName', 'eventTime', 'eventDescription'] },
  { id: 'em-02', module: 'Execution Manager', title: 'Attributes of an event', summary: 'The attributes recorded with one event.', entity: 'EMEventAttribute', input: id('Event id', 'event'), columns: ['id', 'event', 'name', 'value'] },
  { id: 'em-03', module: 'Execution Manager', title: 'Payload of an event', summary: 'The payload record of one event. Its content is cut to a short excerpt.', entity: 'EMEventPayload', input: id('Event id', 'event'), columns: ['id', 'event', 'fileName', 'mimeType', 'type'] },
  { id: 'em-04', module: 'Execution Manager', title: 'Monitored processes', summary: 'The integrations and jobs that are monitored, with their state.', entity: 'EMMonitoredProcess', columns: ['processInstanceId', 'processDefinitionName', 'processType', 'processState', 'moduleName', 'firstEventTime', 'lastEventTime'] },

  // Success Store
  { id: 'ss-01', module: 'Success Store', title: 'Success Store content', summary: 'The best-practice content available from the Success Store.', entity: 'SuccessStoreContent', columns: ['id', 'name', 'type', 'domain', 'status'] },
];

/** The entities a business case reads. Only these can be described or filtered through the case tools. */
export const CASE_ENTITIES: ReadonlySet<string> = new Set(BUSINESS_CASES.filter((c) => !c.unavailable).map((c) => c.entity));

export const findCase = (caseId: string) => BUSINESS_CASES.find((c) => c.id === caseId.toLowerCase());

/** Field names that are never shown, whatever a tenant returns: identity documents, bank details, secrets and special categories of personal data. */
const PROTECTED_FIELD = /(password|secret|token|nationalid|national_id|ssn|passport|bank|iban|accountnumber|dateofbirth|birthdate|^dob$|gender|marital|religion|ethnic|disab|nationality|medical)/i;
export const isProtectedField = (name: string) => PROTECTED_FIELD.test(name);
