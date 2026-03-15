declare module '@garmin/fitsdk' {
  export class Encoder {
    onMesg(mesgNum: number, fields: Record<string, unknown>): void;
    close(): Uint8Array;
  }

  export const Profile: {
    MesgNum: {
      FILE_ID: number;
      EVENT: number;
      RECORD: number;
      LAP: number;
      SESSION: number;
      ACTIVITY: number;
      [key: string]: number;
    };
  };
}
