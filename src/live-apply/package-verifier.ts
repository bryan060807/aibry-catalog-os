import {
  verifyGuardedOperatorPackage as verifyGuardedOperatorPackageCore,
  type GuardedPackagePolicy
} from "./package-verifier-core.js";

export type { GuardedPackagePolicy } from "./package-verifier-core.js";

export async function verifyGuardedOperatorPackage(
  manifestInput: string,
  policy: GuardedPackagePolicy = "bounded-lyric-source-batch"
) {
  return verifyGuardedOperatorPackageCore(manifestInput, policy);
}
