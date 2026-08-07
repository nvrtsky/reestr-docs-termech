import { z } from 'zod';

const codeSchema = z.string().trim().min(1).max(100).regex(/^[a-z0-9_]+$/);
const colorSchema = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/);

export const createSectionSchema = z.object({
  code: codeSchema.optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).nullable().optional(),
  color: colorSchema.nullable().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).default(100),
});

export const updateSectionSchema = createSectionSchema.omit({ code: true }).extend({
  isActive: z.boolean(),
});

const lifecycleConfigSchema = z.object({
  initialStatus: codeSchema,
  states: z.array(z.object({
    code: codeSchema,
    label: z.string().trim().min(1).max(200),
    color: colorSchema.optional(),
    terminal: z.boolean().optional(),
  })).min(1).max(100),
  transitions: z.array(z.object({
    from: codeSchema,
    to: codeSchema,
    roles: z.array(codeSchema).max(100).optional(),
    requiresAttachment: z.boolean().optional(),
  })).max(1_000),
}).superRefine((config, context) => {
  const stateCodes = new Set<string>();
  for (const [index, state] of config.states.entries()) {
    if (stateCodes.has(state.code)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['states', index, 'code'],
        message: `State ${state.code} is duplicated.`,
      });
    }
    stateCodes.add(state.code);
  }
  if (!stateCodes.has(config.initialStatus)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['initialStatus'],
      message: 'Initial status must exist in states.',
    });
  }
  const transitions = new Set<string>();
  for (const [index, transition] of config.transitions.entries()) {
    if (!stateCodes.has(transition.from)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transitions', index, 'from'],
        message: `Transition source ${transition.from} does not exist.`,
      });
    }
    if (!stateCodes.has(transition.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transitions', index, 'to'],
        message: `Transition target ${transition.to} does not exist.`,
      });
    }
    const key = `${transition.from}\u0000${transition.to}`;
    if (transitions.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transitions', index],
        message: `Transition ${transition.from} -> ${transition.to} is duplicated.`,
      });
    }
    transitions.add(key);
    if (transition.roles && new Set(transition.roles).size !== transition.roles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transitions', index, 'roles'],
        message: 'Transition roles contain duplicate values.',
      });
    }
  }
});

export const createLifecycleSchema = z.object({
  code: codeSchema.optional(),
  name: z.string().trim().min(1).max(200),
  config: lifecycleConfigSchema,
});

export const updateLifecycleSchema = createLifecycleSchema.omit({ code: true }).extend({
  isActive: z.boolean(),
});

const rolePermissionsSchema = z.object({
  create: z.boolean(),
  editOwn: z.boolean(),
  editAny: z.boolean(),
  transitionOwn: z.boolean(),
  transitionAny: z.boolean(),
  softDelete: z.boolean(),
  restore: z.boolean(),
  export: z.boolean(),
  administer: z.boolean(),
  byType: z.record(codeSchema, z.object({
    view: z.boolean(),
    create: z.boolean(),
    edit: z.boolean(),
    transition: z.boolean(),
    content: z.boolean(),
    archive: z.boolean(),
    restore: z.boolean(),
    export: z.boolean(),
    finance: z.boolean(),
  })).default({}),
});

export const updateRolePolicySchema = z.object({
  roleName: z.string().trim().min(1).max(200),
  visibleSectionCodes: z.array(z.string().trim().min(1).max(100)).max(100),
  visibleTypeCodes: z.array(z.string().trim().min(1).max(100)).max(500).nullable(),
  hiddenFields: z.array(z.string().trim().min(1).max(200)).max(500),
  permissions: rolePermissionsSchema,
  hideMoney: z.boolean(),
  isActive: z.boolean(),
});

export type UpdateRolePolicyInput = z.infer<typeof updateRolePolicySchema>;

export const replaceUserRolesSchema = z.object({
  items: z.array(z.object({
    userId: z.number().int().positive().safe(),
    userName: z.string().trim().min(1).max(300).nullable().optional(),
    roleCode: z.string().trim().min(1).max(100),
  })).max(10_000),
}).superRefine(({ items }, context) => {
  const userIds = new Set<number>();
  for (const [index, item] of items.entries()) {
    if (userIds.has(item.userId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'userId'],
        message: `User ${item.userId} is mapped more than once.`,
      });
    }
    userIds.add(item.userId);
  }
});

export const replaceDepartmentRolesSchema = z.object({
  items: z.array(z.object({
    departmentId: z.number().int().positive().safe(),
    roleCode: z.string().trim().min(1).max(100),
    priority: z.number().int().min(0).max(1_000_000).default(100),
  })).max(10_000),
}).superRefine(({ items }, context) => {
  const departmentIds = new Set<number>();
  for (const [index, item] of items.entries()) {
    if (departmentIds.has(item.departmentId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'departmentId'],
        message: `Department ${item.departmentId} is mapped more than once.`,
      });
    }
    departmentIds.add(item.departmentId);
  }
});

export const replaceAccessAssignmentsSchema = z.object({
  userRoles: replaceUserRolesSchema,
  departmentRoles: replaceDepartmentRolesSchema,
});
