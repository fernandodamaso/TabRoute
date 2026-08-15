export interface AlarmScheduler {
  schedulePeriodic(name: string, periodInMinutes: number): Promise<void>;
  scheduleOneShot(name: string, when: number): Promise<void>;
}

export interface RecordedAlarmScheduler extends AlarmScheduler {
  calls: Array<
    | { kind: "periodic"; name: string; minutes: number }
    | { kind: "oneShot"; name: string; when: number }
  >;
}

export function createRecordedAlarmScheduler(): RecordedAlarmScheduler {
  const calls: RecordedAlarmScheduler["calls"] = [];
  return {
    calls,
    async schedulePeriodic(name, periodInMinutes) {
      calls.push({ kind: "periodic", name, minutes: periodInMinutes });
    },
    async scheduleOneShot(name, when) {
      calls.push({ kind: "oneShot", name, when });
    }
  };
}
