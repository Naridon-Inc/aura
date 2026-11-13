// The patch a suggested change shows: the lines a comment sits on, against
// the code its ```suggestion block proposes. Lines both keep show as
// unchanged; the rest as removed then added, in order.

export function suggestionPatch(base: string, suggestion: string): string {
  const a = base.split("\n");
  const b = suggestion.split("\n");
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const body: string[] = [];
  let dels: string[] = [];
  let adds: string[] = [];
  const settle = () => {
    body.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      settle();
      body.push(` ${a[i]}`);
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && dp[i + 1][j] >= dp[i][j + 1])) {
      dels.push(`-${a[i++]}`);
    } else {
      adds.push(`+${b[j++]}`);
    }
  }
  settle();
  return [`@@ -1,${a.length} +1,${b.length} @@`, ...body].join("\n");
}
