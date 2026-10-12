import type { PlatformName } from "../../../types.js";
import type { TokenRecord } from "../types.js";

export interface DesktopToken extends TokenRecord {
  platform: PlatformName;
  platformUserId: string;
  containerKey: string;
}
