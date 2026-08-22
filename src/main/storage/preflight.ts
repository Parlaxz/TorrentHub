import { getVolumeSpace } from './volumeSpace.ts';
import {
  InsufficientDiskSpaceError,
} from './errors.ts';
import { computeSpaceRequirement, evaluatePreflight } from './spacePolicy.ts';
import type { PreflightEvaluation, SpaceRequirementInput } from './types.ts';

export async function checkPreflight(
  volumePath: string,
  input: SpaceRequirementInput,
): Promise<PreflightEvaluation> {
  const requirement = computeSpaceRequirement(input);
  const volume = await getVolumeSpace(volumePath);
  return evaluatePreflight(volume.freeBytes, requirement);
}

export async function assertPreflightAllowsStart(
  volumePath: string,
  input: SpaceRequirementInput,
): Promise<PreflightEvaluation> {
  const evaluation = await checkPreflight(volumePath, input);
  if (evaluation.status === 'blocked') {
    throw new InsufficientDiskSpaceError({
      phase: 'preflight',
      freeBytes: evaluation.freeBytes,
      requiredBytes: evaluation.requiredPeakBytes,
    });
  }
  return evaluation;
}
