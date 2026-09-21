// scenarios/accountsetup.js
// Client Admin setup that must run after impersonation and before project
// creation: create an Account, then create a Skills Profile with the required
// assessed skills.

import { check } from 'k6';
import { getJson, postJson, extractId } from '../utils/http.js';
import { logStep, uniqueSuffix } from '../utils/helpers.js';
import { routes } from '../utils/routes.js';

export const REQUIRED_PROFILE_SKILLS = ['Problem Solving', 'Analytical Thinking'];

const PROFILE_DESCRIPTION =
  'Supports daily operational activities by completing assigned tasks accurately and on time while working collaboratively with team members. Follows established processes, communicates effectively, demonstrates a strong willingness to learn, and contributes consistently to team goals and objectives every day.';

export function createClientAccount(clientToken, parentOrgId) {
  const suffix = uniqueSuffix();
  const payload = {
    organizationName: `Load Test Account ${suffix}`,
    name: `Load Test Account ${suffix}`,
    parentOrgId
  };

  const res = postJson(routes.organizations(), payload, clientToken, 'Create Account');
  logStep('Create Account', res);
  const accountOrgId = extractId(res, 'id');

  check(res, {
    'create account: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'create account: organization id returned': () => !!accountOrgId
  });

  return { accountOrgId, accountName: payload.organizationName };
}

export function resolveProfileSkillIds(clientToken) {
  const res = getJson(routes.skills(), clientToken, 'Get Skills for Role Profile');
  logStep('Get Skills for Role Profile', res);

  const found = {};
  try {
    const body = res.json();
    const skills = Array.isArray(body.data) ? body.data : [];
    REQUIRED_PROFILE_SKILLS.forEach((name) => {
      const skill = skills.find((item) => item.name === name);
      if (skill && skill.id) found[name] = skill.id;
    });
  } catch (e) {
    // checks below will report the missing skill ids
  }

  check(res, {
    'role profile skills: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'role profile skills: Problem Solving found': () => !!found['Problem Solving'],
    'role profile skills: Analytical Thinking found': () => !!found['Analytical Thinking']
  });

  return REQUIRED_PROFILE_SKILLS.map((name) => found[name]).filter(Boolean);
}

export function createSkillsProfile(clientToken) {
  const skillIds = resolveProfileSkillIds(clientToken);
  const suffix = uniqueSuffix();
  const payload = {
    title: `Accounts Manager ${suffix}`,
    description: PROFILE_DESCRIPTION,
    roleLevel: 'Junior',
    fileUrl: null,
    skillIds
  };

  const res = postJson(routes.createRoleProfile(), payload, clientToken, 'Create Skills Profile');
  logStep('Create Skills Profile', res);
  const roleProfileId = extractId(res, 'id');
  const selectedSkillNames = extractRoleProfileSkillNames(res);

  check(res, {
    'create skills profile: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'create skills profile: id returned': () => !!roleProfileId,
    'create skills profile: Problem Solving selected': () => selectedSkillNames.includes('Problem Solving'),
    'create skills profile: Analytical Thinking selected': () => selectedSkillNames.includes('Analytical Thinking')
  });

  if (roleProfileId) {
    verifySkillsProfile(clientToken, roleProfileId);
  }

  return { roleProfileId, skillIds };
}

export function verifySkillsProfile(clientToken, roleProfileId) {
  const res = getJson(routes.roleProfileById(roleProfileId), clientToken, 'Get Skills Profile');
  logStep('Get Skills Profile', res);
  const selectedSkillNames = extractRoleProfileSkillNames(res);

  check(res, {
    'get skills profile: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'get skills profile: Problem Solving selected': () => selectedSkillNames.includes('Problem Solving'),
    'get skills profile: Analytical Thinking selected': () => selectedSkillNames.includes('Analytical Thinking')
  });

  return res;
}

export function setupAccountAndSkillsProfile(clientToken, parentOrgId) {
  const account = createClientAccount(clientToken, parentOrgId);
  const profile = createSkillsProfile(clientToken);
  return { ...account, ...profile };
}

function extractRoleProfileSkillNames(res) {
  try {
    const body = res.json();
    const data = body.data || body;
    const skills = Array.isArray(data.skills) ? data.skills : [];
    return skills.map((skill) => skill.name).filter(Boolean);
  } catch (e) {
    return [];
  }
}
