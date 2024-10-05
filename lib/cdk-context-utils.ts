// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { Node } from "constructs";

export const readContext = (node: Node) => ({
  boolean: (key: string, defaultValue = false) => node.tryGetContext(key) ? Boolean(node.tryGetContext(key)) : defaultValue,
  number: (key: string, defaultValue: number) => node.tryGetContext(key) ? Number(node.tryGetContext(key)) : defaultValue,
  string: (key: string, defaultValue: string) => node.tryGetContext(key) ? String(node.tryGetContext(key)) : defaultValue,
  stringOrUndefined: (key: string) => node.tryGetContext(key) ? String(node.tryGetContext(key)) : undefined,
});
