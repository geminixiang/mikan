/**
 * The Conversation office module: canonical identity (`address.ts`), the
 * Workspace/Office layout values (`layout.ts`), the durable registry journal
 * (`registry.ts`), and the boot-time legacy migration (`migration.ts`).
 * Everything outside `src/office/` imports from this barrel.
 */
export {
  assertConversationId,
  assertOfficeKey,
  assertPlatformName,
  conversationOfficeDir,
  createOfficeAddress,
  isOfficeKey,
  officeDirName,
  officeKey,
  officeStateDir,
  sameOffice,
  validateOfficeAddress,
} from "./address.js";
export {
  createWorkspace,
  ensureOfficeDir,
  RESERVED_WORKSPACE_NAMES,
  type Office,
  type Workspace,
} from "./layout.js";
export { listRegisteredOffices, OfficeRegistry, resolveOwnedOfficeAddress } from "./registry.js";
export {
  buildContainerBindTranslator,
  formatUnmigratedOfficesError,
  migrateLegacyOffices,
} from "./migration.js";
