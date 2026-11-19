/** 標準入出力が端末か（端末なら主人が目の前にいるので y/N で聞ける。エージェントや CI では聞けない） */
export const isInteractive = () => !!process.stdin.isTTY && !!process.stdout.isTTY;
