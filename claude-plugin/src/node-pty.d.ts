declare module "node-pty" {
  export interface IPty {
    pid: number;
    process: string;
    cols: number;
    rows: number;
    write(data: string): void;
    resize(columns: number, rows: number): void;
    onData(callback: (data: string) => void): void;
    onExit(callback: (e: { exitCode: number }) => void): void;
    kill(signal?: string): void;
  }

  export function spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    }
  ): IPty;
}
