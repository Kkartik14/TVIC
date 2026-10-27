import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { register } from "tsx/esm/api";

register();
const { isValidErrorCode, MAX_ERROR_CODE_UTF8_BYTES } =
  await import("../packages/core/src/errors.ts");

const repositoryRoot = path.resolve(
  process.env.TVIC_INVENTORY_ROOT ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const factoryNames = new Set([
  "validationError",
  "authError",
  "rateLimitError",
  "connectionError",
  "signatureError",
  "interruptedError",
  "toolError",
  "providerError",
  "mediaError",
  "internalError",
  "timeoutError",
  "cancelledError",
  "normalizeUnknownError",
  "normalizedError",
]);
const allowedStatuses = new Set(["canonical", "legacy_alias", "unchanged", "metadata_only"]);
const allowedDynamicStatuses = new Set([
  "metadata_only",
  "derived_canonical",
  "bounded_derived",
  "validated_passthrough",
]);
const manifestPath = path.join(repositoryRoot, "scripts", "error-code-inventory.json");

async function listTypeScriptFiles(relativeRoot) {
  const absoluteRoot = path.join(repositoryRoot, relativeRoot);
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        result.push(absolutePath);
      }
    }
  }
  await visit(absoluteRoot);
  return result.sort();
}

function sourceLocation(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    file: path.relative(repositoryRoot, sourceFile.fileName),
    line: position.line + 1,
    column: position.character + 1,
  };
}

function sourceScopeName(node, sourceFile) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
      return current.name ? current.name.getText(sourceFile) : null;
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      let declaration = current.parent;
      while (
        declaration &&
        (ts.isParenthesizedExpression(declaration) || ts.isAsExpression(declaration))
      ) {
        declaration = declaration.parent;
      }
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isIdentifier(declaration.name)
      ) {
        return declaration.name.text;
      }
      if (declaration && ts.isPropertyAssignment(declaration)) {
        return ts.isIdentifier(declaration.name) || ts.isStringLiteral(declaration.name)
          ? declaration.name.text
          : null;
      }
      return null;
    }
    current = current.parent;
  }
  return null;
}

function stringLiteral(node) {
  if (!node) return null;
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function propertyValue(objectLiteral, propertyName) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const nameText = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
    if (nameText === propertyName) return property.initializer;
  }
  return null;
}

async function discoverSourceRoots() {
  const packagesRoot = path.join(repositoryRoot, "packages");
  const roots = [];
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceRoot = path.join(packagesRoot, entry.name, "src");
    try {
      await readdir(sourceRoot);
      roots.push(path.relative(repositoryRoot, sourceRoot));
    } catch {}
  }
  return roots.sort();
}

function resolveFactoryExpression(expression, checker, seen) {
  if (!expression || (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression))) {
    return null;
  }
  const symbol = checker.getSymbolAtLocation(expression);
  return resolveFactorySymbol(symbol, checker, seen);
}

function resolveForwardingWrapper(wrapper, checker, seen) {
  if (!wrapper?.body || !Array.isArray(wrapper.parameters)) return null;
  const firstParameter = wrapper.parameters[0];
  const firstParameterName =
    firstParameter && ts.isIdentifier(firstParameter.name) ? firstParameter.name.text : null;
  const calledFactories = new Set();
  let forwardedCallCount = 0;
  let unforwardedCallCount = 0;
  function forwardsParameter(expression) {
    if (!firstParameterName) return false;
    if (ts.isIdentifier(expression)) return expression.text === firstParameterName;
    return (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === firstParameterName
    );
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = resolveFactoryExpression(node.expression, checker, seen);
      if (name && factoryNames.has(name)) {
        calledFactories.add(name);
        if (name === "normalizeUnknownError") {
          unforwardedCallCount += 1;
        } else if (forwardsParameter(node.arguments[0])) {
          forwardedCallCount += 1;
        } else {
          unforwardedCallCount += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(wrapper.body);
  return calledFactories.size === 1 && forwardedCallCount > 0 && unforwardedCallCount === 0
    ? [...calledFactories][0]
    : null;
}

function resolveFactorySymbol(symbol, checker, seen = new Set()) {
  if (!symbol || seen.has(symbol)) return null;
  seen.add(symbol);
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      return resolveFactorySymbol(checker.getAliasedSymbol(symbol), checker, seen);
    } catch {
      return null;
    }
  }
  if (factoryNames.has(symbol.getName()) && isTrustedFactorySymbol(symbol)) {
    return symbol.getName();
  }
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (ts.isFunctionDeclaration(declaration)) {
      const target = resolveForwardingWrapper(declaration, checker, seen);
      if (target) return target;
    }
    if (ts.isVariableDeclaration(declaration)) {
      const direct = resolveFactoryExpression(declaration.initializer, checker, seen);
      if (direct) return direct;
      const target = resolveForwardingWrapper(declaration.initializer, checker, seen);
      if (target) return target;
    }
  }
  return null;
}

function isExportedDeclaration(declaration) {
  if (declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    return true;
  }
  if (ts.isVariableDeclaration(declaration)) {
    const statement = declaration.parent?.parent;
    return (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    );
  }
  return false;
}

function isTrustedFactorySymbol(symbol) {
  return (symbol.getDeclarations() ?? []).some((declaration) => {
    const relativeFile = path.relative(repositoryRoot, declaration.getSourceFile().fileName);
    return (
      /^packages\/[^/]+\/src\/errors\.tsx?$/.test(relativeFile) &&
      isExportedDeclaration(declaration)
    );
  });
}

function isTrustedFactoryModule(statement) {
  const moduleName = stringLiteral(statement.moduleSpecifier);
  return (
    moduleName === "@tvic/core" ||
    moduleName?.endsWith("/errors.js") === true ||
    moduleName?.endsWith("/common.js") === true
  );
}

function factoryAliases(sourceFile, checker) {
  const aliases = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
    if (ts.isNamespaceImport(statement.importClause.namedBindings)) {
      if (isTrustedFactoryModule(statement)) {
        aliases.set(`*${statement.importClause.namedBindings.name.text}`, true);
      }
      continue;
    }
    if (!ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const symbol = checker.getSymbolAtLocation(element.name);
      const importedName = element.propertyName?.text ?? element.name.text;
      const imported =
        (symbol ? resolveFactorySymbol(symbol, checker) : null) ??
        (isTrustedFactoryModule(statement) && factoryNames.has(importedName) ? importedName : null);
      if (imported) aliases.set(element.name.text, imported);
    }
  }

  function wrapperFactoryTarget(wrapper) {
    if (!wrapper?.body || !Array.isArray(wrapper.parameters)) return null;
    const firstParameter = wrapper.parameters[0];
    const firstParameterName =
      firstParameter && ts.isIdentifier(firstParameter.name) ? firstParameter.name.text : null;
    const calledFactories = new Set();
    let forwardedCallCount = 0;
    let unforwardedCallCount = 0;
    function forwardsParameter(expression) {
      if (!firstParameterName) return false;
      if (ts.isIdentifier(expression)) return expression.text === firstParameterName;
      return (
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === firstParameterName
      );
    }
    function visitWrapper(node) {
      if (ts.isCallExpression(node)) {
        const name = factoryName(node.expression, aliases, checker);
        if (name && factoryNames.has(name)) {
          calledFactories.add(name);
          if (name === "normalizeUnknownError") {
            unforwardedCallCount += 1;
            ts.forEachChild(node, visitWrapper);
            return;
          }
          const codeExpression = node.arguments[0];
          if (forwardsParameter(codeExpression)) forwardedCallCount += 1;
          else unforwardedCallCount += 1;
        }
      }
      ts.forEachChild(node, visitWrapper);
    }
    visitWrapper(wrapper.body);
    return calledFactories.size === 1 && forwardedCallCount > 0 && unforwardedCallCount === 0
      ? [...calledFactories][0]
      : null;
  }

  for (let pass = 0; pass <= sourceFile.statements.length; pass += 1) {
    let changed = false;
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        if (factoryNames.has(statement.name.text)) continue;
        const target = wrapperFactoryTarget(statement);
        if (target && aliases.get(statement.name.text) !== target) {
          aliases.set(statement.name.text, target);
          changed = true;
        }
      }
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const target =
          factoryName(declaration.initializer, aliases, checker) ??
          wrapperFactoryTarget(declaration.initializer);
        if (target && factoryNames.has(target) && aliases.get(declaration.name.text) !== target) {
          aliases.set(declaration.name.text, target);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return aliases;
}

function factoryName(expression, aliases, checker) {
  if (ts.isIdentifier(expression)) {
    return aliases.get(expression.text) ?? resolveFactoryExpression(expression, checker);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      aliases.get(expression.name.text) ??
      (aliases.has(`*${expression.expression.getText()}`) && factoryNames.has(expression.name.text)
        ? expression.name.text
        : null) ??
      resolveFactoryExpression(expression, checker) ??
      resolveFactoryExpression(expression.name, checker)
    );
  }
  return null;
}

function ownerForFile(file) {
  const match = /^packages\/([^/]+)\//.exec(file);
  return match?.[1] ?? "unknown";
}

function isCanonicalConstantReference(node, checker) {
  if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return false;
  const symbol = checker.getSymbolAtLocation(node.expression);
  if (!symbol) return false;
  try {
    const resolved =
      (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
    if (!resolved.getName().endsWith("_ERROR_CODES")) return false;
    return (resolved.getDeclarations() ?? []).some((declaration) => {
      const relativeFile = path.relative(repositoryRoot, declaration.getSourceFile().fileName);
      return (
        /^packages\/[^/]+\/(?:src\/constants\.tsx?|dist\/constants\.d\.ts)$/.test(relativeFile) &&
        ts.isVariableDeclaration(declaration) &&
        isExportedDeclaration(declaration)
      );
    });
  } catch {
    return false;
  }
}

function isDurableErrorConstructor(node, checker) {
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return false;
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return false;
  try {
    const resolved =
      (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
    if (resolved.getName() !== "DurableError") return false;
    return (resolved.getDeclarations() ?? []).some((declaration) => {
      const relativeFile = path.relative(repositoryRoot, declaration.getSourceFile().fileName);
      return (
        /^packages\/[^/]+\/(?:src\/dal-errors\.tsx?|dist\/dal-errors\.d\.ts)$/.test(relativeFile) &&
        ts.isClassDeclaration(declaration) &&
        isExportedDeclaration(declaration)
      );
    });
  } catch {
    return false;
  }
}

function dynamicClassification(sourceFile, node) {
  const expression = node ? sourceFile.text.slice(node.getStart(sourceFile), node.getEnd()) : "";
  if (/error_code|vendorCode|providerCode|message\.error\b/.test(expression)) {
    return "vendor_metadata";
  }
  let parent = node?.parent;
  while (parent) {
    if (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent)) {
      if (
        parent.name &&
        ts.isIdentifier(parent.name) &&
        (parent.name.text === "from" || parent.name.text === "normalizedErrorFromErrorLike")
      ) {
        return "bounded_derived";
      }
      break;
    }
    parent = parent.parent;
  }
  if (/\/packages\/core\/src\/errors\.ts$/.test(sourceFile.fileName)) {
    return "validated_passthrough";
  }
  return "derived_canonical";
}

async function discover() {
  const records = new Map();
  const durableRecords = new Map();
  const dynamicCodes = [];

  function addRecord(code, sourceFile, node, kind) {
    const file = path.relative(repositoryRoot, sourceFile.fileName);
    const location = sourceLocation(sourceFile, node);
    const key = `${code}:${file}:${location.line}:${location.column}:${kind}`;
    records.set(key, {
      code,
      owner: ownerForFile(file),
      kind,
      ...location,
    });
  }

  function addDurableRecord(code, sourceFile, node, className) {
    const file = path.relative(repositoryRoot, sourceFile.fileName);
    const location = sourceLocation(sourceFile, node);
    const key = `${code}:${file}:${location.line}:${location.column}`;
    durableRecords.set(key, {
      code,
      owner: ownerForFile(file),
      className,
      ...location,
    });
  }

  const sourceRoots = await discoverSourceRoots();
  const files = (await Promise.all(sourceRoots.map(listTypeScriptFiles))).flat();
  const program = ts.createProgram(files, {
    allowJs: false,
    baseUrl: repositoryRoot,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    paths: {
      "@tvic/*": ["packages/*/src/index.ts"],
      "voice-runtime": ["packages/voice-runtime/src/index.ts"],
    },
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  });
  const checker = program.getTypeChecker();
  for (const file of files) {
    const sourceText = await readFile(file, "utf8");
    const sourceFile =
      program.getSourceFile(file) ??
      ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const aliases = factoryAliases(sourceFile, checker);
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const name = factoryName(node.expression, aliases, checker);
        if (name && factoryNames.has(name)) {
          let codeNode = node.arguments[0];
          if (name === "normalizeUnknownError") {
            const options = node.arguments[1];
            codeNode =
              options && ts.isObjectLiteralExpression(options)
                ? propertyValue(options, "code")
                : null;
          }
          const code = codeNode ? stringLiteral(codeNode) : null;
          if (code) {
            addRecord(code, sourceFile, codeNode, `factory:${name}`);
          } else if (codeNode && isCanonicalConstantReference(codeNode, checker)) {
            // The exported constant declaration is the source-of-truth row.
            // A property reference is not a dynamic vendor code site.
          } else {
            dynamicCodes.push({
              owner: ownerForFile(path.relative(repositoryRoot, file)),
              factory: name,
              scope: sourceScopeName(node, sourceFile),
              classification: dynamicClassification(sourceFile, codeNode),
              expression: codeNode
                ? sourceFile.text.slice(codeNode.getStart(sourceFile), codeNode.getEnd())
                : "<missing-code-expression>",
              ...sourceLocation(sourceFile, node),
            });
          }
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        const code = stringLiteral(node.arguments[0]);
        if (code && /^[A-Z][A-Z0-9_]+$/.test(code)) {
          let parent = node.parent;
          while (parent && !ts.isClassDeclaration(parent)) parent = parent.parent;
          const className = parent && ts.isClassDeclaration(parent) ? parent.name?.text : "unknown";
          addDurableRecord(code, sourceFile, node.arguments[0], className ?? "anonymous");
        }
      }
      if (ts.isNewExpression(node)) {
        const constructorName = isDurableErrorConstructor(node.expression, checker)
          ? "DurableError"
          : null;
        const code = stringLiteral(node.arguments?.[0]);
        if (constructorName === "DurableError" && code && /^[A-Z][A-Z0-9_]+$/.test(code)) {
          addDurableRecord(code, sourceFile, node.arguments[0], constructorName);
        }
      }
      if (ts.isTypeAliasDeclaration(node) && node.name.text === "DurableErrorCode") {
        function collectDurableTypeCodes(value) {
          const code = stringLiteral(value);
          if (code && /^[A-Z][A-Z0-9_]+$/.test(code)) {
            addDurableRecord(code, sourceFile, value, "DurableErrorCode");
          }
          ts.forEachChild(value, collectDurableTypeCodes);
        }
        collectDurableTypeCodes(node.type);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const variableStatement = ts.isVariableStatement(node.parent.parent)
          ? node.parent.parent
          : null;
        const exported = variableStatement?.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        );
        if (exported && node.name.text.endsWith("_ERROR_CODES") && node.initializer) {
          function collectConstants(value) {
            const literal = stringLiteral(value);
            if (literal) {
              addRecord(literal, sourceFile, value, `exported:${node.name.text}`);
            }
            ts.forEachChild(value, collectConstants);
          }
          collectConstants(node.initializer);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  return {
    sourceRoots,
    entries: [...records.values()].sort((left, right) =>
      `${left.code}:${left.file}:${left.line}:${left.column}`.localeCompare(
        `${right.code}:${right.file}:${right.line}:${right.column}`,
      ),
    ),
    durableCodes: [...durableRecords.values()].sort((left, right) =>
      `${left.code}:${left.file}:${left.line}:${left.column}`.localeCompare(
        `${right.code}:${right.file}:${right.line}:${right.column}`,
      ),
    ),
    dynamicCodes: dynamicCodes.sort((left, right) =>
      `${left.file}:${left.line}:${left.column}`.localeCompare(
        `${right.file}:${right.line}:${right.column}`,
      ),
    ),
  };
}

function checkEntry(entry, index) {
  const required = [
    "code",
    "owner",
    "status",
    "legacyAliases",
    "retriable",
    "retryOwner",
    "persistedReadPolicy",
  ];
  const missing = required.filter((field) => !(field in entry));
  if (missing.length > 0) {
    throw new Error(`inventory entry ${index} is missing: ${missing.join(", ")}`);
  }
  if (!isValidErrorCode(entry.code)) {
    throw new Error(`inventory entry ${index} has invalid code: ${String(entry.code)}`);
  }
  if (Buffer.byteLength(entry.code, "utf8") > maxDynamicCodeUtf8Bytes) {
    throw new Error(
      `inventory entry ${entry.code} exceeds the ${maxDynamicCodeUtf8Bytes}-byte code bound`,
    );
  }
  if (!allowedStatuses.has(entry.status)) {
    throw new Error(`inventory entry ${entry.code} has invalid status: ${entry.status}`);
  }
  if (
    !Array.isArray(entry.legacyAliases) ||
    !entry.legacyAliases.every((value) => typeof value === "string")
  ) {
    throw new Error(`inventory entry ${entry.code} has invalid legacyAliases`);
  }
  if (typeof entry.owner !== "string" || entry.owner.length === 0) {
    throw new Error(`inventory entry ${entry.code} has invalid owner`);
  }
  if (
    typeof entry.retriable !== "boolean" ||
    typeof entry.retryOwner !== "string" ||
    entry.retryOwner.length === 0
  ) {
    throw new Error(`inventory entry ${entry.code} has invalid retry policy`);
  }
  if (typeof entry.persistedReadPolicy !== "string") {
    throw new Error(`inventory entry ${entry.code} has invalid persistedReadPolicy`);
  }
  if (entry.status === "legacy_alias" && typeof entry.canonicalCode !== "string") {
    throw new Error(`inventory legacy alias ${entry.code} is missing canonicalCode`);
  }
  if (
    !Array.isArray(entry.sourceLocations) ||
    entry.sourceLocations.length === 0 ||
    !entry.sourceLocations.every(
      (location) =>
        typeof location.file === "string" &&
        Number.isInteger(location.line) &&
        location.line > 0 &&
        Number.isInteger(location.column) &&
        location.column > 0 &&
        typeof location.kind === "string",
    )
  ) {
    throw new Error(`inventory entry ${entry.code} has invalid sourceLocations`);
  }
}

function checkDurableEntry(entry, index) {
  const required = [
    "code",
    "owner",
    "className",
    "status",
    "retriable",
    "retryOwner",
    "persistedReadPolicy",
    "sourceLocations",
  ];
  const missing = required.filter((field) => !(field in entry));
  if (missing.length > 0) {
    throw new Error(`durable error inventory entry ${index} is missing: ${missing.join(", ")}`);
  }
  if (
    typeof entry.code !== "string" ||
    !/^[A-Z][A-Z0-9_]+$/.test(entry.code) ||
    typeof entry.owner !== "string" ||
    typeof entry.className !== "string"
  ) {
    throw new Error(`durable error inventory entry ${index} is invalid`);
  }
  if (!allowedStatuses.has(entry.status)) {
    throw new Error(`durable error inventory entry ${entry.code} has invalid status`);
  }
  if (typeof entry.owner !== "string" || entry.owner.length === 0) {
    throw new Error(`durable error inventory entry ${entry.code} has invalid owner`);
  }
  if (
    typeof entry.retriable !== "boolean" ||
    typeof entry.retryOwner !== "string" ||
    entry.retryOwner.length === 0
  ) {
    throw new Error(`durable error inventory entry ${entry.code} has invalid retry policy`);
  }
  if (typeof entry.persistedReadPolicy !== "string") {
    throw new Error(`durable error inventory entry ${entry.code} has invalid persistedReadPolicy`);
  }
  if (
    !Array.isArray(entry.sourceLocations) ||
    entry.sourceLocations.length === 0 ||
    !entry.sourceLocations.every(
      (location) =>
        typeof location.file === "string" &&
        Number.isInteger(location.line) &&
        location.line > 0 &&
        Number.isInteger(location.column) &&
        location.column > 0,
    )
  ) {
    throw new Error(`durable error inventory entry ${entry.code} has invalid sourceLocations`);
  }
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function containsFactoryCall(node, expectedFactory) {
  let found = false;
  function visit(current) {
    if (found) return;
    if (ts.isCallExpression(current)) {
      const name = callName(current.expression);
      if (name && (expectedFactory === null || name === expectedFactory)) found = true;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function containsMigrationEvidence(node, helper, expectedFactory, expectedFunction, schema) {
  let found = false;
  function visit(current) {
    if (found) return;
    if (ts.isCallExpression(current) && callName(current.expression) === helper) {
      const configuration = current.arguments[0];
      if (configuration && ts.isObjectLiteralExpression(configuration)) {
        const exercise = propertyValue(configuration, "exercise");
        const expected = propertyValue(configuration, "expected");
        const isFunction =
          exercise && (ts.isArrowFunction(exercise) || ts.isFunctionExpression(exercise));
        const hasExpectedObject = expected && ts.isObjectLiteralExpression(expected);
        const hasAssertions =
          hasExpectedObject &&
          (schema.requiredAssertions ?? []).every(
            (assertion) => propertyValue(expected, assertion) !== null,
          );
        const requiredCall = expectedFunction ?? expectedFactory;
        if (
          isFunction &&
          hasExpectedObject &&
          hasAssertions &&
          containsFactoryCall(exercise, requiredCall)
        ) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function hasBehavioralTestEvidence(
  text,
  compatibilityTest,
  schema,
  expectedFactory = null,
  expectedFunction = compatibilityTest.function,
) {
  const sourceFile = ts.createSourceFile(
    compatibilityTest.file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const helper = schema.requiredRuntimeHelper;
  if (typeof helper !== "string" || helper.length === 0) return false;
  let found = false;
  function visit(node) {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      const marker = stringLiteral(node.arguments[0]);
      if (marker?.includes(compatibilityTest.pattern) && (name === "test" || name === "it")) {
        for (const argument of node.arguments.slice(1)) {
          if (
            (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
            containsMigrationEvidence(argument, helper, expectedFactory, expectedFunction, schema)
          ) {
            found = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function matchesDynamicMapping(code, mapping) {
  if (mapping.canonicalCodes.includes(code)) return true;
  return (mapping.canonicalPatterns ?? []).some((pattern) => {
    if (pattern === "error.<bounded-name>") {
      return code === "unknown.error" || /^error\.[a-z][a-z0-9_]*$/.test(code);
    }
    try {
      return new RegExp(`^(?:${pattern})$`).test(code);
    } catch {
      return false;
    }
  });
}

function canonicalSourceBindings(bindings) {
  return JSON.stringify(
    [...bindings]
      .map((binding) => ({
        file: binding.file,
        factories: [...binding.factories].sort(),
      }))
      .sort((left, right) => left.file.localeCompare(right.file)),
  );
}

function sourceBindingImportMatches(runnerPath, moduleSpecifier, binding) {
  if (!moduleSpecifier.startsWith(".")) return false;
  const importedPath = path.resolve(path.dirname(runnerPath), moduleSpecifier);
  const importedRelative = path.relative(repositoryRoot, importedPath);
  const sourceRelative = binding.file.replace(/\.tsx?$/, "");
  const candidates = new Set([
    sourceRelative,
    `${sourceRelative}.ts`,
    `${sourceRelative}.tsx`,
    sourceRelative.replace(/\/src\//, "/dist/") + ".js",
    sourceRelative.replace(/\/src\//, "/dist/") + ".mjs",
  ]);
  return (
    candidates.has(importedRelative.replace(/\.js$/, ".ts")) || candidates.has(importedRelative)
  );
}

function runnerImportsSourceBinding(runnerPath, text, binding) {
  const sourceFile = ts.createSourceFile(
    runnerPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let found = false;
  function visit(node) {
    if (found) return;
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      sourceBindingImportMatches(runnerPath, node.moduleSpecifier.text, binding)
    ) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0]) &&
      sourceBindingImportMatches(runnerPath, node.arguments[0].text, binding)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function resolvedSymbolAt(node, checker) {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return null;
  try {
    return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  } catch {
    return null;
  }
}

function factoryCallName(node, checker) {
  if (!ts.isCallExpression(node)) return null;
  const sourceFile = node.getSourceFile();
  return factoryName(node.expression, factoryAliases(sourceFile, checker), checker);
}

function sourceEntryCallMatches(node, entry, checker) {
  if (!ts.isCallExpression(node)) return false;
  const relativeFile = path.relative(repositoryRoot, node.getSourceFile().fileName);
  const location = sourceLocation(node.getSourceFile(), node);
  return (
    relativeFile === entry.file &&
    location.line === entry.line &&
    location.column === entry.column &&
    factoryCallName(node, checker) === entry.factory
  );
}

function sourceFactoryCallMatches(node, entry, checker) {
  return sourceEntryCallMatches(node, entry, checker);
}

function declarationHasReachableSourceEntryCall(declaration, entry, checker) {
  const body = ts.isVariableDeclaration(declaration)
    ? declaration.initializer
    : ts.isArrowFunction(declaration) ||
        ts.isFunctionExpression(declaration) ||
        ts.isFunctionDeclaration(declaration) ||
        ts.isMethodDeclaration(declaration)
      ? declaration.body
      : undefined;
  if (!body) return false;

  function expressionMayThrow(expression) {
    let mayThrow = false;
    function visit(node) {
      if (mayThrow) return;
      if (
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node)
      ) {
        return;
      }
      if (
        ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isAwaitExpression(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node) ||
        ts.isTaggedTemplateExpression(node)
      ) {
        mayThrow = true;
        return;
      }
      ts.forEachChild(node, visit);
    }
    if (expression) visit(expression);
    return mayThrow;
  }

  function literalBooleanValue(expression) {
    if (!expression) return undefined;
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isParenthesizedExpression(expression)) {
      return literalBooleanValue(expression.expression);
    }
    return undefined;
  }

  function statementMayThrow(statement) {
    if (ts.isThrowStatement(statement)) return true;
    if (ts.isReturnStatement(statement)) return expressionMayThrow(statement.expression);
    if (ts.isBlock(statement)) {
      for (const child of statement.statements) {
        if (statementMayThrow(child)) return true;
        if (analyzeStatement(child).completes) return false;
      }
      return false;
    }
    if (ts.isIfStatement(statement)) {
      if (expressionMayThrow(statement.expression)) return true;
      const condition = literalBooleanValue(statement.expression);
      if (condition === true) return statementMayThrow(statement.thenStatement);
      if (condition === false) {
        return statement.elseStatement ? statementMayThrow(statement.elseStatement) : false;
      }
      return (
        statementMayThrow(statement.thenStatement) ||
        (statement.elseStatement && statementMayThrow(statement.elseStatement))
      );
    }
    if (ts.isTryStatement(statement)) {
      const tryMayThrow = statementMayThrow(statement.tryBlock);
      return (
        (tryMayThrow &&
          (!statement.catchClause || statementMayThrow(statement.catchClause.block))) ||
        (statement.finallyBlock !== undefined && statementMayThrow(statement.finallyBlock))
      );
    }
    if (ts.isWhileStatement(statement)) {
      if (expressionMayThrow(statement.expression)) return true;
      return (
        literalBooleanValue(statement.expression) !== false &&
        statementMayThrow(statement.statement)
      );
    }
    if (ts.isDoStatement(statement)) {
      return statementMayThrow(statement.statement) || expressionMayThrow(statement.expression);
    }
    if (ts.isForStatement(statement)) {
      if (statement.initializer && expressionMayThrow(statement.initializer)) return true;
      if (expressionMayThrow(statement.condition)) return true;
      return (
        literalBooleanValue(statement.condition) !== false &&
        (statementMayThrow(statement.statement) || expressionMayThrow(statement.incrementor))
      );
    }
    if (ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
      return (
        expressionMayThrow(statement.initializer) ||
        expressionMayThrow(statement.expression) ||
        statementMayThrow(statement.statement)
      );
    }
    if (ts.isSwitchStatement(statement)) {
      return (
        expressionMayThrow(statement.expression) ||
        statement.caseBlock.clauses.some((clause) =>
          clause.statements.some((child) => statementMayThrow(child)),
        )
      );
    }
    return expressionMayThrow(statement);
  }

  function analyzeStatement(statement) {
    if (ts.isReturnStatement(statement)) {
      const mapped = expressionReturnsSourceFactory(statement.expression, entry, checker);
      const returnsNull =
        statement.expression === undefined ||
        statement.expression.kind === ts.SyntaxKind.NullKeyword;
      return {
        completes: true,
        hasReturn: true,
        hasMappedReturn: mapped,
        hasUnmappedObjectReturn: !mapped && !returnsNull,
      };
    }
    if (ts.isThrowStatement(statement)) {
      return {
        completes: true,
        hasReturn: false,
        hasMappedReturn: false,
        hasUnmappedObjectReturn: false,
      };
    }
    if (ts.isBlock(statement)) return analyzeStatements(statement.statements);
    if (ts.isIfStatement(statement)) {
      const condition = literalBooleanValue(statement.expression);
      const thenResult = analyzeStatement(statement.thenStatement);
      const elseResult = statement.elseStatement
        ? analyzeStatement(statement.elseStatement)
        : {
            completes: false,
            hasReturn: false,
            hasMappedReturn: false,
            hasUnmappedObjectReturn: false,
          };
      if (condition === true) return thenResult;
      if (condition === false) return elseResult;
      return {
        completes: thenResult.completes && elseResult.completes,
        hasReturn: thenResult.hasReturn || elseResult.hasReturn,
        hasMappedReturn: thenResult.hasMappedReturn || elseResult.hasMappedReturn,
        hasUnmappedObjectReturn:
          thenResult.hasUnmappedObjectReturn || elseResult.hasUnmappedObjectReturn,
      };
    }
    if (ts.isTryStatement(statement)) {
      const tryResult = analyzeStatement(statement.tryBlock);
      const catchReachable = Boolean(
        statement.catchClause && statementMayThrow(statement.tryBlock),
      );
      const catchResult =
        catchReachable && statement.catchClause
          ? analyzeStatement(statement.catchClause.block)
          : {
              completes: false,
              hasReturn: false,
              hasMappedReturn: false,
              hasUnmappedObjectReturn: false,
            };
      const bodyResult = {
        completes: tryResult.completes && (!catchReachable || catchResult.completes),
        hasReturn: tryResult.hasReturn || catchResult.hasReturn,
        hasMappedReturn: tryResult.hasMappedReturn || catchResult.hasMappedReturn,
        hasUnmappedObjectReturn:
          tryResult.hasUnmappedObjectReturn || catchResult.hasUnmappedObjectReturn,
      };
      if (!statement.finallyBlock) return bodyResult;
      const finallyResult = analyzeStatement(statement.finallyBlock);
      return finallyResult.completes
        ? finallyResult
        : {
            completes: bodyResult.completes,
            hasReturn: bodyResult.hasReturn,
            hasMappedReturn: bodyResult.hasMappedReturn || finallyResult.hasMappedReturn,
            hasUnmappedObjectReturn:
              bodyResult.hasUnmappedObjectReturn || finallyResult.hasUnmappedObjectReturn,
          };
    }
    return {
      completes: false,
      hasReturn: false,
      hasMappedReturn: false,
      hasUnmappedObjectReturn: false,
    };
  }

  function analyzeStatements(statements) {
    let hasReturn = false;
    let hasMappedReturn = false;
    let hasUnmappedObjectReturn = false;
    for (const statement of statements) {
      const result = analyzeStatement(statement);
      hasReturn ||= result.hasReturn;
      hasMappedReturn ||= result.hasMappedReturn;
      hasUnmappedObjectReturn ||= result.hasUnmappedObjectReturn;
      if (result.completes) {
        return { completes: true, hasReturn, hasMappedReturn, hasUnmappedObjectReturn };
      }
    }
    return { completes: false, hasReturn, hasMappedReturn, hasUnmappedObjectReturn };
  }

  if (!ts.isBlock(body)) return expressionReturnsSourceFactory(body, entry, checker);
  const result = analyzeStatements(body.statements);
  return result.hasReturn && result.hasMappedReturn && !result.hasUnmappedObjectReturn;
}

function functionDeclarations(symbol) {
  return (symbol?.getDeclarations() ?? []).filter(
    (declaration) =>
      ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isArrowFunction(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isVariableDeclaration(declaration),
  );
}

function declarationReturnsFirstParameter(declaration, checker) {
  const parameters = declaration.parameters;
  const firstParameter = parameters?.[0];
  if (!firstParameter || !ts.isIdentifier(firstParameter.name)) return false;
  const parameterSymbol = checker.getSymbolAtLocation(firstParameter.name);
  if (!parameterSymbol) return false;

  const returns = [];
  const body =
    ts.isVariableDeclaration(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration)
      ? (declaration.initializer ?? declaration.body)
      : undefined;
  if (!body) return false;
  if (!ts.isBlock(body)) {
    returns.push(body);
  } else {
    function collectReturns(node) {
      if (
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node)
      ) {
        return;
      }
      if (ts.isReturnStatement(node)) {
        returns.push(node.expression);
        return;
      }
      ts.forEachChild(node, collectReturns);
    }
    collectReturns(body);
  }
  if (returns.length === 0) return false;

  function preservesParameter(expression) {
    if (!expression) return false;
    if (ts.isParenthesizedExpression(expression)) {
      return preservesParameter(expression.expression);
    }
    if (ts.isIdentifier(expression)) {
      return resolvedSymbolAt(expression, checker) === parameterSymbol;
    }
    if (ts.isCallExpression(expression)) {
      const callee = resolvedSymbolAt(expression.expression, checker);
      return (
        callee?.getName() === "trustedNormalizedError" &&
        expression.arguments.length === 1 &&
        functionDeclarations(callee).some((candidate) =>
          declarationReturnsFirstParameter(candidate, checker),
        ) &&
        preservesParameter(expression.arguments[0])
      );
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.some(
        (property) => ts.isSpreadAssignment(property) && preservesParameter(property.expression),
      );
    }
    return false;
  }

  return returns.every(preservesParameter);
}

function expressionReturnsSourceFactory(expression, entry, checker, seen = new Set()) {
  if (!expression) return false;
  if (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression)) {
    return expressionReturnsSourceFactory(expression.expression, entry, checker, seen);
  }
  if (ts.isNewExpression(expression)) {
    return (expression.arguments ?? []).some((argument) =>
      expressionReturnsSourceFactory(argument, entry, checker, seen),
    );
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) {
        return expressionReturnsSourceFactory(property.expression, entry, checker, seen);
      }
      if (ts.isPropertyAssignment(property)) {
        return expressionReturnsSourceFactory(property.initializer, entry, checker, seen);
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return expressionReturnsSourceFactory(property.name, entry, checker, seen);
      }
      return false;
    });
  }
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return declarationReturnsSourceFactory(expression, entry, checker, seen);
  }
  if (ts.isCallExpression(expression)) {
    if (sourceFactoryCallMatches(expression, entry, checker)) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === "from" &&
      resolvedSymbolAt(expression.expression.expression, checker)?.getName() ===
        "TvicThrowableError"
    ) {
      const result = expression.arguments.some((argument) =>
        expressionReturnsSourceFactory(argument, entry, checker, seen),
      );
      return result;
    }
    const callee = resolvedSymbolAt(expression.expression, checker);
    if (!callee || seen.has(callee)) return false;
    const declarations = functionDeclarations(callee);
    if (
      declarations.some((declaration) => declarationReturnsFirstParameter(declaration, checker))
    ) {
      return expression.arguments.some((argument) =>
        expressionReturnsSourceFactory(argument, entry, checker, seen),
      );
    }
    seen.add(callee);
    if (
      declarations.some((declaration) =>
        declarationReturnsSourceFactory(declaration, entry, checker, seen),
      )
    ) {
      return true;
    }
    return false;
  }
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    const symbol = resolvedSymbolAt(expression, checker);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    return functionDeclarations(symbol).some((declaration) =>
      declarationReturnsSourceFactory(declaration, entry, checker, seen),
    );
  }
  return false;
}

function expressionInvokesCompatibilityFunction(expression, entry, checker) {
  const expectedFunction = entry.compatibilityTest?.function;
  if (typeof expectedFunction !== "string" || expectedFunction.length === 0) return false;
  let found = false;
  function visit(node, isRoot = false) {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const symbol = resolvedSymbolAt(node.expression, checker);
      if (symbol?.getName() === expectedFunction) {
        found = true;
        return;
      }
    }
    if (
      !isRoot &&
      (ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    ts.forEachChild(node, (child) => visit(child));
  }
  visit(expression, true);
  return found;
}

function expressionBindsToSourceFactory(expression, entry, checker) {
  return (
    expressionReturnsSourceFactory(expression, entry, checker) ||
    expressionInvokesCompatibilityFunction(expression, entry, checker)
  );
}

function declarationReturnsSourceFactory(declaration, entry, checker, seen) {
  if (ts.isVariableDeclaration(declaration)) {
    return expressionReturnsSourceFactory(declaration.initializer, entry, checker, seen);
  }
  if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
    if (!ts.isBlock(declaration.body)) {
      return expressionReturnsSourceFactory(declaration.body, entry, checker, seen);
    }
    return (
      analyzeFactoryStatements(declaration.body.statements, entry, checker, seen) ||
      declarationHasReachableSourceEntryCall(declaration, entry, checker)
    );
  }
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
    if (!declaration.body) return false;
    return (
      analyzeFactoryStatements(declaration.body.statements, entry, checker, seen) ||
      declarationHasReachableSourceEntryCall(declaration, entry, checker)
    );
  }
  return false;
}

function recordFactoryCallNodes(sourceFile) {
  const calls = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "recordFactoryCall"
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return calls;
}

function hasUnboundRecordFactoryCallReference(sourceFile) {
  let found = false;
  function visit(node, parent) {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === "recordFactoryCall") {
      const isDirectCallee =
        parent !== undefined && ts.isCallExpression(parent) && parent.expression === node;
      const isBindingName =
        parent !== undefined &&
        ts.isBindingElement(parent) &&
        parent.name === node &&
        parent.propertyName === undefined;
      if (!isDirectCallee && !isBindingName) found = true;
    }
    ts.forEachChild(node, (child) => visit(child, node));
  }
  visit(sourceFile, undefined);
  return found;
}

function hasForbiddenDynamicCode(sourceFile) {
  let found = false;
  const globalObjects = new Set(["globalThis", "global", "window"]);
  function visit(node) {
    if (found) return;
    if (ts.isIdentifier(node) && (node.text === "eval" || node.text === "Function")) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.name.text === "construct" &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Reflect"))
    ) {
      found = true;
      return;
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      globalObjects.has(node.expression.text)
    ) {
      const property = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : stringLiteral(node.argumentExpression);
      if (property === "eval" || property === "Function") {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function runnerContainsForbiddenDynamicCode(runnerPath) {
  const program = ts.createProgram([runnerPath], {
    allowJs: true,
    allowImportingTsExtensions: true,
    checkJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  });
  return program.getSourceFiles().some((sourceFile) => {
    const absolute = path.resolve(sourceFile.fileName);
    return (
      absolute.startsWith(`${repositoryRoot}${path.sep}`) &&
      !absolute.includes(`${path.sep}node_modules${path.sep}`) &&
      hasForbiddenDynamicCode(sourceFile)
    );
  });
}

function runnerUsesOnlyBoundFactoryCalls(runnerPath, entries) {
  const program = ts.createProgram([runnerPath], {
    allowJs: true,
    allowImportingTsExtensions: true,
    checkJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  });
  const sourceFile = program.getSourceFile(runnerPath);
  if (!sourceFile) return false;
  const hasUnboundReference = hasUnboundRecordFactoryCallReference(sourceFile);
  if (hasUnboundReference) return false;
  const calls = recordFactoryCallNodes(sourceFile);
  if (calls.length === 0) return false;
  const checker = program.getTypeChecker();
  const results = calls.map((call) => {
    const [sourceLocationArgument, factoryArgument, invokeArgument] = call.arguments;
    if (!sourceLocationArgument || !factoryArgument || !invokeArgument) return false;
    if (
      !(
        ts.isStringLiteral(sourceLocationArgument) ||
        ts.isNoSubstitutionTemplateLiteral(sourceLocationArgument)
      ) ||
      !(ts.isStringLiteral(factoryArgument) || ts.isNoSubstitutionTemplateLiteral(factoryArgument))
    ) {
      return false;
    }
    const candidates = entries.filter(
      (entry) =>
        dynamicEvidenceKey(entry) === sourceLocationArgument.text &&
        entry.factory === factoryArgument.text,
    );
    return candidates.some((entry) =>
      expressionBindsToSourceFactory(invokeArgument, entry, checker),
    );
  });
  if (!results.every(Boolean)) return false;
  const evidenceCalls = [];
  function collectEvidenceCalls(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "assertErrorMigrationEvidence"
    ) {
      evidenceCalls.push(node);
    }
    ts.forEachChild(node, collectEvidenceCalls);
  }
  collectEvidenceCalls(sourceFile);
  if (evidenceCalls.length === 0) return false;
  return evidenceCalls.every((call) => {
    const options = call.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) return false;
    const exercise = propertyValue(options, "exercise");
    return expressionReturnsBoundFactoryRecord(exercise, entries, checker);
  });
}

function expressionReturnsBoundFactoryRecord(expression, entries, checker, seen = new Set()) {
  if (!expression) return false;
  if (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression)) {
    return expressionReturnsBoundFactoryRecord(expression.expression, entries, checker, seen);
  }
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    if (!ts.isBlock(expression.body)) {
      return expressionReturnsBoundFactoryRecord(expression.body, entries, checker, seen);
    }
    return analyzeBoundFactoryRecordStatements(expression.body.statements, entries, checker, seen);
  }
  if (ts.isCallExpression(expression)) {
    if (
      !ts.isIdentifier(expression.expression) ||
      expression.expression.text !== "recordFactoryCall" ||
      expression.arguments.length !== 3
    ) {
      return false;
    }
    const sourceLocationArgument = stringLiteral(expression.arguments[0]);
    const factoryArgument = stringLiteral(expression.arguments[1]);
    if (!sourceLocationArgument || !factoryArgument) return false;
    return entries.some(
      (entry) =>
        sourceLocationArgument === dynamicEvidenceKey(entry) &&
        factoryArgument === entry.factory &&
        expressionBindsToSourceFactory(expression.arguments[2], entry, checker),
    );
  }
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    const symbol = resolvedSymbolAt(expression, checker);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    return functionDeclarations(symbol).some((declaration) =>
      declarationReturnsBoundFactoryRecord(declaration, entries, checker, seen),
    );
  }
  return false;
}

function declarationReturnsBoundFactoryRecord(declaration, entries, checker, seen) {
  if (ts.isVariableDeclaration(declaration)) {
    return expressionReturnsBoundFactoryRecord(declaration.initializer, entries, checker, seen);
  }
  if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
    if (!ts.isBlock(declaration.body)) {
      return expressionReturnsBoundFactoryRecord(declaration.body, entries, checker, seen);
    }
    return analyzeBoundFactoryRecordStatements(declaration.body.statements, entries, checker, seen);
  }
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
    if (!declaration.body) return false;
    return analyzeBoundFactoryRecordStatements(declaration.body.statements, entries, checker, seen);
  }
  return false;
}

function analyzeBoundFactoryRecordStatements(statements, entries, checker, seen) {
  let completes = false;
  let exact = true;
  for (const statement of statements) {
    if (ts.isReturnStatement(statement)) {
      completes = true;
      exact =
        exact && expressionReturnsBoundFactoryRecord(statement.expression, entries, checker, seen);
      continue;
    }
    if (ts.isThrowStatement(statement)) {
      completes = true;
      continue;
    }
    if (ts.isVariableStatement(statement)) continue;
    if (ts.isBlock(statement)) {
      const nested = analyzeBoundFactoryRecordStatements(
        statement.statements,
        entries,
        checker,
        seen,
      );
      completes = completes || nested.completes;
      exact = exact && nested.exact;
      continue;
    }
    if (ts.isIfStatement(statement)) {
      const thenResult = analyzeBoundFactoryRecordStatement(
        statement.thenStatement,
        entries,
        checker,
        seen,
      );
      const elseResult = statement.elseStatement
        ? analyzeBoundFactoryRecordStatement(statement.elseStatement, entries, checker, seen)
        : { completes: false, exact: true };
      completes = completes || (thenResult.completes && elseResult.completes);
      exact = exact && thenResult.exact && elseResult.exact;
      continue;
    }
    exact = false;
  }
  return completes && exact;
}

function analyzeBoundFactoryRecordStatement(statement, entries, checker, seen) {
  if (ts.isReturnStatement(statement)) {
    return {
      completes: true,
      exact: expressionReturnsBoundFactoryRecord(statement.expression, entries, checker, seen),
    };
  }
  if (ts.isThrowStatement(statement)) return { completes: true, exact: true };
  if (ts.isVariableStatement(statement)) return { completes: false, exact: true };
  if (ts.isBlock(statement)) {
    return analyzeBoundFactoryRecordStatements(statement.statements, entries, checker, seen);
  }
  if (ts.isIfStatement(statement)) {
    const thenResult = analyzeBoundFactoryRecordStatement(
      statement.thenStatement,
      entries,
      checker,
      seen,
    );
    const elseResult = statement.elseStatement
      ? analyzeBoundFactoryRecordStatement(statement.elseStatement, entries, checker, seen)
      : { completes: false, exact: true };
    return {
      completes: thenResult.completes && elseResult.completes,
      exact: thenResult.exact && elseResult.exact,
    };
  }
  return { completes: false, exact: false };
}

function analyzeFactoryStatements(statements, entry, checker, seen) {
  let completes = false;
  let exact = true;
  for (const statement of statements) {
    if (ts.isReturnStatement(statement)) {
      completes = true;
      exact = exact && expressionReturnsSourceFactory(statement.expression, entry, checker, seen);
      continue;
    }
    if (ts.isThrowStatement(statement)) {
      completes = true;
      continue;
    }
    if (ts.isVariableStatement(statement)) continue;
    if (ts.isBlock(statement)) {
      const nested = analyzeFactoryStatements(statement.statements, entry, checker, seen);
      completes = completes || nested.completes;
      exact = exact && nested.exact;
      continue;
    }
    if (ts.isIfStatement(statement)) {
      const thenResult = analyzeFactoryStatement(statement.thenStatement, entry, checker, seen);
      const elseResult = statement.elseStatement
        ? analyzeFactoryStatement(statement.elseStatement, entry, checker, seen)
        : { completes: false, exact: true };
      completes = completes || (thenResult.completes && elseResult.completes);
      exact = exact && thenResult.exact && elseResult.exact;
      continue;
    }
    exact = false;
  }
  return completes && exact;
}

function analyzeFactoryStatement(statement, entry, checker, seen) {
  if (ts.isReturnStatement(statement)) {
    return {
      completes: true,
      exact: expressionReturnsSourceFactory(statement.expression, entry, checker, seen),
    };
  }
  if (ts.isThrowStatement(statement)) return { completes: true, exact: true };
  if (ts.isVariableStatement(statement)) return { completes: false, exact: true };
  if (ts.isBlock(statement)) {
    const result = analyzeFactoryStatements(statement.statements, entry, checker, seen);
    return { completes: result, exact: result };
  }
  if (ts.isIfStatement(statement)) {
    const thenResult = analyzeFactoryStatement(statement.thenStatement, entry, checker, seen);
    const elseResult = statement.elseStatement
      ? analyzeFactoryStatement(statement.elseStatement, entry, checker, seen)
      : { completes: false, exact: true };
    return {
      completes: thenResult.completes && elseResult.completes,
      exact: thenResult.exact && elseResult.exact,
    };
  }
  return { completes: false, exact: false };
}

function runnerInvokesSourceEntry(runnerPath, entry) {
  const program = ts.createProgram([runnerPath], {
    allowJs: true,
    allowImportingTsExtensions: true,
    checkJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  });
  const sourceFile = program.getSourceFile(runnerPath);
  if (!sourceFile) return false;
  const checker = program.getTypeChecker();
  let found = false;
  function visit(node) {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "recordFactoryCall" &&
      node.arguments[0] &&
      (ts.isStringLiteral(node.arguments[0]) ||
        ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) &&
      node.arguments[0].text === dynamicEvidenceKey(entry) &&
      node.arguments[1] &&
      (ts.isStringLiteral(node.arguments[1]) ||
        ts.isNoSubstitutionTemplateLiteral(node.arguments[1])) &&
      node.arguments[1].text === entry.factory &&
      node.arguments[2]
    ) {
      found = expressionBindsToSourceFactory(node.arguments[2], entry, checker);
      if (found) return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

const discovered = await discover();
if (process.argv.includes("--print")) {
  await new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(discovered, null, 2)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  process.exit(0);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const releaseMode = process.argv.includes("--release");
const dynamicCompatibilitySchema = manifest.dynamicSchema?.compatibilityTest ?? {};
const maxDynamicCodeUtf8Bytes = manifest.dynamicSchema?.maxCodeUtf8Bytes;
if (manifest.version !== 1 || !Array.isArray(manifest.entries)) {
  throw new Error("error-code inventory manifest must have version 1 and an entries array");
}
if (!Number.isInteger(maxDynamicCodeUtf8Bytes) || maxDynamicCodeUtf8Bytes <= 0) {
  throw new Error("error-code inventory must define a positive maxCodeUtf8Bytes bound");
}
if (maxDynamicCodeUtf8Bytes !== MAX_ERROR_CODE_UTF8_BYTES) {
  throw new Error("dynamic code inventory and core error-code limits differ");
}
if (manifest.dynamicCodePolicy?.maxUtf8Bytes !== maxDynamicCodeUtf8Bytes) {
  throw new Error("dynamic code policy and dynamic schema byte bounds disagree");
}
if (
  !Array.isArray(dynamicCompatibilitySchema.evidenceObject?.required) ||
  !["exercise", "expected"].every((field) =>
    dynamicCompatibilitySchema.evidenceObject.required.includes(field),
  )
) {
  throw new Error("dynamic compatibility schema must require exercise and expected evidence");
}
const dynamicEvidenceExpectations = Array.isArray(manifest.dynamicEvidenceExpectations)
  ? manifest.dynamicEvidenceExpectations
  : manifest.dynamicEvidenceExpectationsFile
    ? JSON.parse(
        await readFile(path.join(repositoryRoot, manifest.dynamicEvidenceExpectationsFile), "utf8"),
      ).entries
    : null;
if (!Array.isArray(dynamicEvidenceExpectations)) {
  throw new Error("error-code inventory must define dynamic evidence expectations");
}
const evidenceExpectationMap = new Map();
for (const expectation of dynamicEvidenceExpectations) {
  if (
    typeof expectation?.sourceKey !== "string" ||
    typeof expectation.mappingKey !== "string" ||
    typeof expectation.factory !== "string" ||
    typeof expectation.code !== "string" ||
    typeof expectation.retriable !== "boolean" ||
    typeof expectation.retryOwner !== "string" ||
    typeof expectation.persistedReadPolicy !== "string" ||
    evidenceExpectationMap.has(expectation.sourceKey)
  ) {
    throw new Error("dynamic evidence expectations contain an invalid or duplicate row");
  }
  evidenceExpectationMap.set(expectation.sourceKey, expectation);
}
manifest.entries.forEach(checkEntry);
if (!Array.isArray(manifest.durableCodes)) {
  throw new Error("error-code inventory manifest must have a durableCodes array");
}
manifest.durableCodes.forEach(checkDurableEntry);

if (JSON.stringify(manifest.sourceRoots) !== JSON.stringify(discovered.sourceRoots)) {
  throw new Error("error-code inventory sourceRoots are stale");
}

const manifestCodes = new Set(manifest.entries.map((entry) => entry.code));
const missing = discovered.entries.filter((entry) => !manifestCodes.has(entry.code));
if (missing.length > 0) {
  const summary = [
    ...new Set(missing.map((entry) => `${entry.code} (${entry.file}:${entry.line})`)),
  ];
  throw new Error(`inventory is missing source codes:\n${summary.join("\n")}`);
}
if (manifestCodes.size !== manifest.entries.length) {
  throw new Error("error-code inventory contains duplicate code entries");
}
const discoveredCodes = new Set(discovered.entries.map((entry) => entry.code));
const staleCodes = [...manifestCodes].filter((code) => !discoveredCodes.has(code));
if (staleCodes.length > 0) {
  throw new Error(`inventory contains codes no longer present in source: ${staleCodes.join(", ")}`);
}

const dynamicRules = Array.isArray(manifest.dynamicCodes) ? manifest.dynamicCodes : [];
if (!Array.isArray(manifest.dynamicMappings)) {
  throw new Error("error-code inventory manifest must have a dynamicMappings array");
}
const dynamicMappings = new Map();
for (const mapping of manifest.dynamicMappings) {
  if (
    typeof mapping.key !== "string" ||
    mapping.key.length === 0 ||
    dynamicMappings.has(mapping.key) ||
    !Array.isArray(mapping.canonicalCodes) ||
    mapping.canonicalCodes.length === 0 ||
    !mapping.canonicalCodes.every((code) => typeof code === "string" && code.length > 0) ||
    ("canonicalPatterns" in mapping &&
      (!Array.isArray(mapping.canonicalPatterns) ||
        mapping.canonicalPatterns.length === 0 ||
        !mapping.canonicalPatterns.every(
          (pattern) => typeof pattern === "string" && pattern.length > 0,
        ))) ||
    typeof mapping.selector !== "string" ||
    mapping.selector.length === 0 ||
    !["exhaustive", "observed", "bounded"].includes(mapping.coverage) ||
    typeof mapping.evidenceRunner !== "object" ||
    mapping.evidenceRunner === null ||
    typeof mapping.evidenceRunner.file !== "string" ||
    mapping.evidenceRunner.file.length === 0 ||
    typeof mapping.evidenceRunner.export !== "string" ||
    mapping.evidenceRunner.export.length === 0 ||
    !Array.isArray(mapping.sourceBindings) ||
    mapping.sourceBindings.length === 0 ||
    !mapping.sourceBindings.every(
      (binding) =>
        typeof binding?.file === "string" &&
        binding.file.length > 0 &&
        Array.isArray(binding.factories) &&
        binding.factories.length > 0 &&
        binding.factories.every((factory) => factoryNames.has(factory)),
    ) ||
    !Array.isArray(mapping.evidenceRunner.sourceBindings) ||
    !mapping.evidenceRunner.sourceBindings.every(
      (binding) =>
        typeof binding?.file === "string" &&
        binding.file.length > 0 &&
        Array.isArray(binding.factories) &&
        binding.factories.length > 0 &&
        binding.factories.every((factory) => factoryNames.has(factory)),
    ) ||
    canonicalSourceBindings(mapping.evidenceRunner.sourceBindings) !==
      canonicalSourceBindings(mapping.sourceBindings) ||
    typeof mapping.retryOwner !== "string" ||
    mapping.retryOwner.length === 0 ||
    typeof mapping.persistedReadPolicy !== "string" ||
    mapping.persistedReadPolicy.length === 0
  ) {
    throw new Error("dynamic code inventory contains an invalid dynamic mapping");
  }
  dynamicMappings.set(mapping.key, mapping);
}
for (const [mappingKey, mapping] of dynamicMappings) {
  const expectedBindings = [];
  for (const file of new Set(
    dynamicRules.filter((entry) => entry.mappingKey === mappingKey).map((entry) => entry.file),
  )) {
    expectedBindings.push({
      file,
      factories: [
        ...new Set(
          dynamicRules
            .filter((entry) => entry.mappingKey === mappingKey && entry.file === file)
            .map((entry) => entry.factory),
        ),
      ],
    });
  }
  if (
    canonicalSourceBindings(mapping.sourceBindings) !== canonicalSourceBindings(expectedBindings)
  ) {
    throw new Error(`dynamic mapping source bindings are stale for ${mappingKey}`);
  }
}
const declaredDynamicStatuses = new Set(manifest.dynamicCodePolicy?.statuses ?? []);
if (
  declaredDynamicStatuses.size !== allowedDynamicStatuses.size ||
  [...allowedDynamicStatuses].some((status) => !declaredDynamicStatuses.has(status))
) {
  throw new Error("dynamic code policy statuses and dynamic schema statuses disagree");
}
const overflowPolicy = manifest.dynamicSchema?.overflowPolicy;
for (const requiredPolicy of [
  "validated_passthrough",
  "bounded_derived",
  "vendor_metadata",
  "persisted_read",
]) {
  if (typeof overflowPolicy?.[requiredPolicy] !== "string") {
    throw new Error(`dynamic code inventory is missing overflow policy ${requiredPolicy}`);
  }
}
const durableUnknownCodePolicy = manifest.durableUnknownCodePolicy;
const expectedDurableUnknownCodePolicy = {
  behavior: "reject_as_corrupt_record",
  errorType: "CorruptRecordError",
  retriable: false,
  retry: "never",
  recovery: "never",
  persistedRepresentation: "not_returned",
};
if (JSON.stringify(durableUnknownCodePolicy) !== JSON.stringify(expectedDurableUnknownCodePolicy)) {
  throw new Error(
    "durable unknown-code policy must deterministically reject as CorruptRecordError",
  );
}
if (
  dynamicRules.some(
    (entry) =>
      !allowedDynamicStatuses.has(entry.status) ||
      typeof entry.sourceField !== "string" ||
      entry.sourceField.length === 0 ||
      !Number.isInteger(entry.maxUtf8Bytes) ||
      entry.maxUtf8Bytes <= 0 ||
      entry.maxUtf8Bytes !== maxDynamicCodeUtf8Bytes ||
      typeof entry.file !== "string" ||
      entry.file.length === 0 ||
      typeof entry.factory !== "string" ||
      entry.factory.length === 0 ||
      typeof entry.compatibilityTest !== "object" ||
      entry.compatibilityTest === null ||
      typeof entry.compatibilityTest.function !== "string" ||
      entry.compatibilityTest.function.length === 0 ||
      typeof entry.mappingKey !== "string" ||
      entry.mappingKey.length === 0 ||
      !dynamicMappings.has(entry.mappingKey) ||
      typeof entry.compatibilityTest.file !== "string" ||
      entry.compatibilityTest.file.length === 0 ||
      typeof entry.compatibilityTest.pattern !== "string" ||
      entry.compatibilityTest.pattern.length === 0 ||
      typeof entry.compatibilityTest.function !== "string" ||
      entry.compatibilityTest.function.length === 0,
  )
) {
  throw new Error("dynamic code inventory contains an incomplete metadata_only row");
}
const dynamicSiteKey = (entry) =>
  `${entry.file}#${entry.scope ?? entry.compatibilityTest.function}#${entry.factory}`;
const dynamicEvidenceKey = (entry) =>
  `${entry.compatibilityTest.file}#${entry.compatibilityTest.function}`;
const discoveredDynamic = new Set(discovered.dynamicCodes.map(dynamicSiteKey));
const manifestDynamic = new Set(dynamicRules.map(dynamicSiteKey));
if (discoveredDynamic.size !== discovered.dynamicCodes.length) {
  throw new Error("source contains dynamic error sites without a unique named scope");
}
if (manifestDynamic.size !== dynamicRules.length) {
  throw new Error("dynamic code inventory contains duplicate source sites");
}
const missingDynamic = [...discoveredDynamic].filter((key) => !manifestDynamic.has(key));
const staleDynamic = [...manifestDynamic].filter((key) => !discoveredDynamic.has(key));
if (missingDynamic.length > 0 || staleDynamic.length > 0) {
  throw new Error(
    `dynamic code inventory is stale: missing=[${missingDynamic.join(", ")}], stale=[${staleDynamic.join(", ")}]`,
  );
}
const manifestDynamicBySite = new Map(dynamicRules.map((entry) => [dynamicSiteKey(entry), entry]));
if (evidenceExpectationMap.size !== discoveredDynamic.size) {
  throw new Error("dynamic evidence expectations are stale");
}
for (const discoveredEntry of discovered.dynamicCodes) {
  const manifestEntry = manifestDynamicBySite.get(dynamicSiteKey(discoveredEntry));
  const expectation = evidenceExpectationMap.get(dynamicSiteKey(discoveredEntry));
  const expectedStatus =
    discoveredEntry.classification === "vendor_metadata"
      ? "metadata_only"
      : discoveredEntry.classification;
  if (manifestEntry?.status !== expectedStatus) {
    throw new Error(
      `dynamic code classification mismatch at ${dynamicSiteKey(discoveredEntry)}: ` +
        `expected ${expectedStatus}`,
    );
  }
  if (
    !expectation ||
    expectation.mappingKey !== manifestEntry.mappingKey ||
    expectation.factory !== discoveredEntry.factory ||
    manifestEntry.classification !== discoveredEntry.classification ||
    manifestEntry.expression !== discoveredEntry.expression
  ) {
    throw new Error(
      `dynamic evidence or expression is stale at ${dynamicSiteKey(discoveredEntry)}`,
    );
  }
  const mapping = dynamicMappings.get(manifestEntry.mappingKey);
  if (
    discoveredEntry.classification === "validated_passthrough" &&
    (mapping.coverage !== "observed" || !Array.isArray(mapping.canonicalPatterns))
  ) {
    throw new Error(
      `validated passthrough mapping must be observed and pattern-bounded at ${dynamicSiteKey(discoveredEntry)}`,
    );
  }
  if (
    discoveredEntry.classification === "bounded_derived" &&
    (mapping.coverage !== "bounded" || !Array.isArray(mapping.canonicalPatterns))
  ) {
    throw new Error(
      `bounded derived mapping must be bounded and pattern-bounded at ${dynamicSiteKey(discoveredEntry)}`,
    );
  }
}

const manifestDurableCodes = new Set(manifest.durableCodes.map((entry) => entry.code));
if (manifestDurableCodes.size !== manifest.durableCodes.length) {
  throw new Error("durable error inventory contains duplicate code entries");
}
const discoveredDurableCodes = new Set(discovered.durableCodes.map((entry) => entry.code));
const missingDurable = [...discoveredDurableCodes].filter(
  (code) => !manifestDurableCodes.has(code),
);
const staleDurable = [...manifestDurableCodes].filter((code) => !discoveredDurableCodes.has(code));
if (missingDurable.length > 0 || staleDurable.length > 0) {
  throw new Error(
    `durable error inventory is stale: missing=${missingDurable.join(", ") || "none"}, ` +
      `stale=${staleDurable.join(", ") || "none"}`,
  );
}

if (releaseMode) {
  if (manifest.mode !== "release") {
    throw new Error("release inventory check requires manifest.mode=release");
  }
  const unreviewed = manifest.entries.filter((entry) => entry.status === "unchanged");
  if (unreviewed.length > 0) {
    throw new Error(`release inventory contains ${unreviewed.length} unchanged rows`);
  }
  const unreviewedDurable = manifest.durableCodes.filter((entry) => entry.status === "unchanged");
  if (unreviewedDurable.length > 0) {
    throw new Error(
      `release inventory contains ${unreviewedDurable.length} unchanged durable rows`,
    );
  }
  if (!Array.isArray(manifest.canonicalMappings)) {
    throw new Error("release inventory is missing canonicalMappings");
  }
  const mappings = new Map(
    manifest.canonicalMappings.map((mapping) => [mapping.canonicalCode, mapping]),
  );
  const knownCodes = new Set([
    ...manifest.entries.map((entry) => entry.code),
    ...manifest.entries.flatMap((entry) => entry.legacyAliases),
    ...manifest.durableCodes.map((entry) => entry.code),
  ]);
  for (const canonicalCode of manifest.canonicalTargets ?? []) {
    const mapping = mappings.get(canonicalCode);
    if (
      !mapping ||
      !Array.isArray(mapping.sourceCodes) ||
      mapping.sourceCodes.length === 0 ||
      typeof mapping.compatibilityTest !== "object" ||
      mapping.compatibilityTest === null ||
      typeof mapping.compatibilityTest.file !== "string" ||
      typeof mapping.compatibilityTest.pattern !== "string" ||
      typeof mapping.retryOwner !== "string" ||
      mapping.retryOwner.length === 0 ||
      typeof mapping.persistedReadPolicy !== "string" ||
      mapping.persistedReadPolicy.length === 0
    ) {
      throw new Error(`release inventory is missing mapping evidence for ${canonicalCode}`);
    }
    if (!mapping.sourceCodes.every((sourceCode) => knownCodes.has(sourceCode))) {
      throw new Error(`release inventory mapping has unknown source code for ${canonicalCode}`);
    }
    const testText = await readFile(
      path.join(repositoryRoot, mapping.compatibilityTest.file),
      "utf8",
    );
    if (
      !hasBehavioralTestEvidence(testText, mapping.compatibilityTest, dynamicCompatibilitySchema)
    ) {
      throw new Error(`release inventory compatibility evidence is missing for ${canonicalCode}`);
    }
  }
  for (const dynamic of dynamicRules) {
    const mapping = dynamicMappings.get(dynamic.mappingKey);
    const knownMappingCodes = new Set([
      ...manifest.entries.map((entry) => entry.code),
      ...manifest.entries.flatMap((entry) => entry.legacyAliases),
      ...manifest.durableCodes.map((entry) => entry.code),
      ...(manifest.canonicalTargets ?? []),
      ...manifest.dynamicMappings.flatMap((candidate) => candidate.canonicalCodes),
    ]);
    if (!mapping.canonicalCodes.every((code) => knownMappingCodes.has(code))) {
      throw new Error(
        `release dynamic mapping has unknown canonical code for ${dynamic.file}:${dynamic.line}`,
      );
    }
    const testText = await readFile(
      path.join(repositoryRoot, dynamic.compatibilityTest.file),
      "utf8",
    );
    if (
      !hasBehavioralTestEvidence(
        testText,
        dynamic.compatibilityTest,
        dynamicCompatibilitySchema,
        dynamic.factory,
      )
    ) {
      throw new Error(
        `release inventory dynamic compatibility evidence is missing at ${dynamic.file}:${dynamic.line}`,
      );
    }
  }
  const executedRunnerResults = new Map();
  for (const [mappingKey, mapping] of dynamicMappings) {
    const entries = dynamicRules.filter((entry) => entry.mappingKey === mappingKey);
    if (entries.length === 0) continue;
    const runnerPath = path.resolve(repositoryRoot, mapping.evidenceRunner.file);
    let runnerText;
    try {
      runnerText = await readFile(runnerPath, "utf8");
    } catch {
      throw new Error(
        `release dynamic evidence runner is missing for ${mappingKey}: ${mapping.evidenceRunner.file}`,
      );
    }
    if (runnerContainsForbiddenDynamicCode(runnerPath)) {
      throw new Error(
        `release dynamic evidence runner contains forbidden eval, Function, dynamic import, or reflective code for ${mappingKey}`,
      );
    }
    if (!runnerUsesOnlyBoundFactoryCalls(runnerPath, entries)) {
      throw new Error(
        `release dynamic evidence runner contains an unbound or non-production recordFactoryCall for ${mappingKey}`,
      );
    }
    for (const binding of mapping.sourceBindings) {
      if (!runnerImportsSourceBinding(runnerPath, runnerText, binding)) {
        throw new Error(
          `release dynamic evidence runner does not import source binding ${binding.file} for ${mappingKey}`,
        );
      }
    }
    for (const entry of entries) {
      if (!runnerInvokesSourceEntry(runnerPath, entry)) {
        throw new Error(
          `release dynamic evidence runner does not invoke the imported source symbol for ${dynamicSiteKey(entry)}`,
        );
      }
    }
    let runnerModule;
    try {
      runnerModule = await import(pathToFileURL(runnerPath).href);
    } catch (error) {
      throw new Error(
        `release dynamic evidence runner could not load for ${mappingKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const runner = runnerModule[mapping.evidenceRunner.export];
    if (typeof runner !== "function") {
      throw new Error(`release dynamic evidence runner export is not callable for ${mappingKey}`);
    }
    if (
      canonicalSourceBindings(runnerModule.evidenceSourceBindings ?? []) !==
      canonicalSourceBindings(mapping.sourceBindings)
    ) {
      throw new Error(`release dynamic evidence runner is not bound to source for ${mappingKey}`);
    }
    const observedFactories = new WeakMap();
    const validatedEvidence = new WeakMap();
    const expectedEntries = new Map(entries.map((entry) => [dynamicEvidenceKey(entry), entry]));
    const recordFactoryCall = async (evidenceKey, factory, invoke) => {
      if (
        typeof evidenceKey !== "string" ||
        typeof factory !== "string" ||
        typeof invoke !== "function"
      ) {
        throw new Error(
          `dynamic evidence runner supplied an invalid factory call for ${mappingKey}`,
        );
      }
      const expectedEntry = expectedEntries.get(evidenceKey);
      if (!expectedEntry || expectedEntry.factory !== factory) {
        throw new Error(
          `dynamic evidence runner supplied an unrecognized evidence key or factory for ${mappingKey}`,
        );
      }
      const sourceLocation = dynamicSiteKey(expectedEntry);
      const value = await invoke();
      if (typeof value !== "object" || value === null) {
        throw new Error(
          `dynamic evidence factory ${sourceLocation}:${factory} did not return an object`,
        );
      }
      if ("retryOwner" in value || "persistedReadPolicy" in value) {
        throw new Error(
          `dynamic evidence factory ${sourceLocation}:${factory} returned inventory-only policy metadata`,
        );
      }
      observedFactories.set(value, {
        sourceLocation,
        factory,
        code: value.code,
        retriable: value.retriable,
      });
      return value;
    };
    const assertErrorMigrationEvidence = async ({ evidenceKey, factory, exercise, expected }) => {
      if (
        typeof evidenceKey !== "string" ||
        typeof factory !== "string" ||
        typeof exercise !== "function" ||
        typeof expected !== "object" ||
        expected === null
      ) {
        throw new Error(`dynamic evidence has an invalid exercise for ${mappingKey}`);
      }
      const expectedEntry = expectedEntries.get(evidenceKey);
      if (!expectedEntry || expectedEntry.factory !== factory) {
        throw new Error(
          `dynamic evidence asserted an unrecognized evidence key or factory for ${mappingKey}`,
        );
      }
      const sourceLocation = dynamicSiteKey(expectedEntry);
      const actual = await exercise();
      const observed = observedFactories.get(actual);
      if (!observed || observed.sourceLocation !== sourceLocation || observed.factory !== factory) {
        throw new Error(
          `dynamic evidence exercise did not return the observed ${sourceLocation}:${factory} result for ${mappingKey}`,
        );
      }
      if ("retryOwner" in actual || "persistedReadPolicy" in actual) {
        throw new Error(
          `dynamic evidence exercise added inventory-only policy metadata to ${sourceLocation}:${factory}`,
        );
      }
      for (const field of ["code", "retriable"]) {
        if (
          !(field in actual) ||
          !(field in expected) ||
          actual[field] !== observed[field] ||
          observed[field] !== expected[field]
        ) {
          throw new Error(
            `dynamic evidence ${mappingKey} returned mismatched or mutated ${field}: actual=${String(actual[field])} observed=${String(observed[field])} expected=${String(expected[field])}`,
          );
        }
      }
      if (
        typeof expected.retryOwner !== "string" ||
        typeof expected.persistedReadPolicy !== "string"
      ) {
        throw new Error(`dynamic evidence ${mappingKey} has invalid policy metadata`);
      }
      validatedEvidence.set(actual, {
        sourceLocation,
        factory,
        code: observed.code,
        retriable: observed.retriable,
        retryOwner: expected.retryOwner,
        persistedReadPolicy: expected.persistedReadPolicy,
      });
      return actual;
    };
    const observations = await runner({
      mappingKey,
      sourceBindings: mapping.sourceBindings,
      entries: entries.map((entry) => ({
        evidenceKey: dynamicEvidenceKey(entry),
        sourceLocation: dynamicSiteKey(entry),
        file: entry.file,
        line: entry.line,
        column: entry.column,
        factory: entry.factory,
        expected: (() => {
          const expected = evidenceExpectationMap.get(dynamicSiteKey(entry));
          return expected ? Object.freeze({ ...expected }) : expected;
        })(),
      })),
      recordFactoryCall,
      assertErrorMigrationEvidence,
    });
    if (!Array.isArray(observations)) {
      throw new Error(`release dynamic evidence runner returned no rows for ${mappingKey}`);
    }
    for (const observation of observations) {
      const evidenceEntry =
        typeof observation?.evidenceKey === "string"
          ? expectedEntries.get(observation.evidenceKey)
          : undefined;
      const sourceLocation = evidenceEntry ? dynamicSiteKey(evidenceEntry) : null;
      if (
        sourceLocation === null ||
        typeof observation.factory !== "string" ||
        typeof observation.observed !== "object" ||
        observation.observed === null
      ) {
        throw new Error(`release dynamic evidence returned an invalid row for ${mappingKey}`);
      }
      if ("retryOwner" in observation.observed || "persistedReadPolicy" in observation.observed) {
        throw new Error(
          `release dynamic evidence mutated a production result with inventory-only policy metadata for ${mappingKey}:${sourceLocation}`,
        );
      }
      const validation = validatedEvidence.get(observation.observed);
      if (
        !validation ||
        validation.sourceLocation !== sourceLocation ||
        validation.factory !== observation.factory
      ) {
        throw new Error(
          `release dynamic evidence observation was not validated by assertErrorMigrationEvidence for ${mappingKey}:${sourceLocation}`,
        );
      }
      const key = `${mappingKey}:${sourceLocation}`;
      if (executedRunnerResults.has(key)) {
        throw new Error(`release dynamic evidence duplicated ${key}`);
      }
      executedRunnerResults.set(key, observation);
      const expectedMapping = dynamicMappings.get(mappingKey);
      const expectedEvidence = evidenceExpectationMap.get(sourceLocation);
      if (
        !expectedEvidence ||
        observation.factory !== expectedEvidence.factory ||
        observation.observed.code !== validation.code ||
        observation.observed.retriable !== validation.retriable ||
        validation.code !== expectedEvidence.code ||
        validation.retriable !== expectedEvidence.retriable ||
        observation.observed.code !== expectedEvidence.code ||
        observation.observed.retriable !== expectedEvidence.retriable ||
        validation.retryOwner !== expectedEvidence.retryOwner ||
        validation.persistedReadPolicy !== expectedEvidence.persistedReadPolicy ||
        validation.retryOwner !== expectedMapping.retryOwner ||
        validation.persistedReadPolicy !== expectedMapping.persistedReadPolicy ||
        typeof observation.observed.code !== "string" ||
        Buffer.byteLength(observation.observed.code, "utf8") > maxDynamicCodeUtf8Bytes ||
        !matchesDynamicMapping(observation.observed.code, expectedMapping)
      ) {
        throw new Error(`release dynamic evidence policy mismatch for ${key}`);
      }
      if (
        expectedMapping.coverage === "exhaustive" &&
        !expectedMapping.canonicalCodes.includes(observation.observed.code)
      ) {
        throw new Error(`release exhaustive dynamic evidence returned an unknown code for ${key}`);
      }
    }
    for (const entry of entries) {
      const key = `${mappingKey}:${dynamicSiteKey(entry)}`;
      const observation = executedRunnerResults.get(key);
      if (!observation || observation.factory !== entry.factory) {
        throw new Error(`release dynamic evidence is missing for ${dynamicSiteKey(entry)}`);
      }
    }
  }
}

process.stdout.write(
  `error-code inventory ok: ${discovered.entries.length} source records, ` +
    `${discovered.durableCodes.length} durable codes, ${discovered.dynamicCodes.length} dynamic sites\n`,
);
