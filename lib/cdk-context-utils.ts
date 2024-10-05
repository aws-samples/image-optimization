import { Stack } from "aws-cdk-lib";

export const getContextVariables = (stack: Stack) => {
  const { node } = stack;
  return {
    boolean: (key: string, defaultValue = false) => node.tryGetContext(key) ? Boolean(node.tryGetContext(key)) : defaultValue,
    number: (key: string, defaultValue: number) => node.tryGetContext(key) ? Number(node.tryGetContext(key)) : defaultValue,
    string: (key: string, defaultValue: string) => node.tryGetContext(key) ? String(node.tryGetContext(key)) : defaultValue,
    stringOrUndefined: (key: string) => node.tryGetContext(key) ? String(node.tryGetContext(key)) : undefined,
  }
}