import { getVolumeSpace } from './volumeSpace.ts';
import { computeLiveHeadroom } from './spacePolicy.ts';
import type { LiveHeadroomInput, LiveHeadroomResult, VolumeSpaceInfo } from './types.ts';

export async function sampleLiveHeadroom(
  volumePath: string,
  input: Omit<LiveHeadroomInput, 'currentFreeBytes'>,
): Promise<LiveHeadroomResult> {
  const volume: VolumeSpaceInfo = await getVolumeSpace(volumePath);
  return computeLiveHeadroom({ ...input, currentFreeBytes: volume.freeBytes });
}

export interface LiveStoragePoller {
  sample(): Promise<LiveHeadroomResult>;
  start(onSample: (result: LiveHeadroomResult) => void, onError?: (error: unknown) => void): void;
  stop(): void;
}

export function createLiveStoragePoller(
  volumePath: string,
  input: Omit<LiveHeadroomInput, 'currentFreeBytes'>,
  intervalMs = 1000,
): LiveStoragePoller {
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const poller: LiveStoragePoller = {
    sample() {
      return sampleLiveHeadroom(volumePath, input);
    },
    start(onSample, onError) {
      if (running) return;
      running = true;
      const tick = async () => {
        if (!running) return;
        try {
          onSample(await poller.sample());
        } catch (error) {
          if (onError) onError(error);
        }
      };
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop() {
      running = false;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
  return poller;
}
