const EPSILON = 1e-6;
const EXPECTED_SUITE = 'haiyue-navmesh-multilayer-conformance-v1';

export function validateNavMeshMultilayerCorpus(corpus) {
  if (!corpus || corpus.schemaVersion !== 1 || corpus.suite !== EXPECTED_SUITE) {
    throw new Error(`Invalid NavMesh multilayer corpus header; expected ${EXPECTED_SUITE}.`);
  }
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    throw new Error('NavMesh multilayer corpus must contain at least one case.');
  }
  const caseIds = new Set();
  for (const corpusCase of corpus.cases) {
    requireUniqueId(corpusCase?.id, caseIds, 'case');
    validateCase(corpusCase);
  }
  return corpus;
}

export function evaluateNavMeshMultilayerCorpus(corpus) {
  validateNavMeshMultilayerCorpus(corpus);
  const results = [];
  const violations = [];
  for (const corpusCase of corpus.cases) {
    for (const query of corpusCase.queries) {
      const actual = evaluateNavMeshMultilayerQuery(corpusCase, query);
      results.push({ caseId: corpusCase.id, queryId: query.id, ...actual });
      const mismatch = compareExpected(query.expected, actual);
      if (mismatch.length > 0) {
        violations.push({
          caseId: corpusCase.id,
          queryId: query.id,
          mismatches: mismatch,
        });
      }
    }
  }
  return {
    suite: corpus.suite,
    status: violations.length === 0 ? 'passed' : 'failed',
    queryCount: results.length,
    results,
    violations,
  };
}

export function evaluateNavMeshMultilayerQuery(corpusCase, query) {
  const context = createCaseContext(corpusCase);
  const startRegion = resolvePointRegion(context, query.start);
  const targetRegion = resolvePointRegion(context, query.target);
  const obstacleState = resolveObstacleState(context, query);
  const blockedPortalIds = collectBlockedPortalIds(context, query, obstacleState);
  const disabledPortalIds = new Set(query.disabledPortalIds ?? []);

  if (!startRegion || !targetRegion) {
    return {
      status: startRegion ? 'invalid-target' : 'invalid-start',
      startRegion: startRegion?.id ?? null,
      targetRegion: targetRegion?.id ?? null,
      regionPath: startRegion ? [startRegion.id] : [],
      portalPath: [],
      blockedPortalIds: [...blockedPortalIds].sort(),
      obstacleRegions: obstacleState.regionById,
    };
  }
  if (startRegion.id === targetRegion.id) {
    return {
      status: 'complete',
      startRegion: startRegion.id,
      targetRegion: targetRegion.id,
      regionPath: [startRegion.id],
      portalPath: [],
      blockedPortalIds: [...blockedPortalIds].sort(),
      obstacleRegions: obstacleState.regionById,
    };
  }

  const queue = [startRegion.id];
  const visited = new Set(queue);
  const parent = new Map();
  let cursor = 0;
  while (cursor < queue.length && !visited.has(targetRegion.id)) {
    const regionId = queue[cursor++];
    for (const edge of edgesFrom(context, regionId)) {
      if (disabledPortalIds.has(edge.portalId)
        || blockedPortalIds.has(edge.portalId)
        || visited.has(edge.to)) continue;
      visited.add(edge.to);
      parent.set(edge.to, { regionId, portalId: edge.portalId });
      queue.push(edge.to);
    }
  }

  if (!visited.has(targetRegion.id)) {
    return {
      status: 'unreachable',
      startRegion: startRegion.id,
      targetRegion: targetRegion.id,
      regionPath: [startRegion.id],
      portalPath: [],
      blockedPortalIds: [...blockedPortalIds].sort(),
      obstacleRegions: obstacleState.regionById,
    };
  }

  const regionPath = [targetRegion.id];
  const portalPath = [];
  let current = targetRegion.id;
  while (current !== startRegion.id) {
    const step = parent.get(current);
    if (!step) throw new Error(`Oracle parent chain for ${query.id} is incomplete.`);
    portalPath.push(step.portalId);
    regionPath.push(step.regionId);
    current = step.regionId;
  }
  regionPath.reverse();
  portalPath.reverse();
  return {
    status: 'complete',
    startRegion: startRegion.id,
    targetRegion: targetRegion.id,
    regionPath,
    portalPath,
    blockedPortalIds: [...blockedPortalIds].sort(),
    obstacleRegions: obstacleState.regionById,
  };
}

function validateCase(corpusCase) {
  if (!Array.isArray(corpusCase.features) || corpusCase.features.length === 0) {
    throw new Error(`NavMesh corpus case ${corpusCase.id} has no feature labels.`);
  }
  const upLength = vectorLength(corpusCase.up);
  if (Math.abs(upLength - 1) > EPSILON) {
    throw new Error(`NavMesh corpus case ${corpusCase.id} up vector must be normalized.`);
  }
  if (!Number.isFinite(corpusCase.surfaceTolerance) || corpusCase.surfaceTolerance <= 0) {
    throw new Error(`NavMesh corpus case ${corpusCase.id} surfaceTolerance must be positive.`);
  }
  if (!Array.isArray(corpusCase.regions) || corpusCase.regions.length === 0) {
    throw new Error(`NavMesh corpus case ${corpusCase.id} has no regions.`);
  }

  const basis = createPlanarBasis(corpusCase.up);
  const regionIds = new Set();
  for (const region of corpusCase.regions) {
    requireUniqueId(region?.id, regionIds, `${corpusCase.id} region`);
    if (typeof region.layer !== 'string' || region.layer.length === 0) {
      throw new Error(`NavMesh region ${corpusCase.id}/${region.id} has no stable layer id.`);
    }
    if (!Array.isArray(region.vertices) || region.vertices.length < 3) {
      throw new Error(`NavMesh region ${corpusCase.id}/${region.id} needs at least three vertices.`);
    }
    for (const vertex of region.vertices) requirePoint(vertex, `${corpusCase.id}/${region.id} vertex`);
    const elevation = dot(region.vertices[0], corpusCase.up);
    if (region.vertices.some(vertex => Math.abs(dot(vertex, corpusCase.up) - elevation) > corpusCase.surfaceTolerance)) {
      throw new Error(`NavMesh region ${corpusCase.id}/${region.id} is not planar along its up vector.`);
    }
    const projected = region.vertices.map(vertex => projectPoint(vertex, basis));
    if (Math.abs(signedPolygonArea(projected)) <= EPSILON) {
      throw new Error(`NavMesh region ${corpusCase.id}/${region.id} has zero projected area.`);
    }
  }

  const portalIds = new Set();
  for (const portal of corpusCase.portals ?? []) {
    requireUniqueId(portal?.id, portalIds, `${corpusCase.id} portal`);
    if (!regionIds.has(portal.from) || !regionIds.has(portal.to) || portal.from === portal.to) {
      throw new Error(`NavMesh portal ${corpusCase.id}/${portal.id} has invalid region endpoints.`);
    }
    requirePoint(portal.position, `${corpusCase.id}/${portal.id} position`);
    if (!Number.isFinite(portal.width) || portal.width <= 0 || typeof portal.bidirectional !== 'boolean') {
      throw new Error(`NavMesh portal ${corpusCase.id}/${portal.id} has invalid width or direction.`);
    }
  }

  const obstacleIds = new Set();
  for (const obstacle of corpusCase.obstacles ?? []) {
    requireUniqueId(obstacle?.id, obstacleIds, `${corpusCase.id} obstacle`);
    requirePoint(obstacle.position, `${corpusCase.id}/${obstacle.id} position`);
    if (!Number.isFinite(obstacle.radius) || obstacle.radius < 0 || typeof obstacle.enabled !== 'boolean') {
      throw new Error(`NavMesh obstacle ${corpusCase.id}/${obstacle.id} is invalid.`);
    }
  }

  const queryIds = new Set();
  for (const query of corpusCase.queries ?? []) {
    requireUniqueId(query?.id, queryIds, `${corpusCase.id} query`);
    requirePoint(query.start, `${corpusCase.id}/${query.id} start`);
    requirePoint(query.target, `${corpusCase.id}/${query.id} target`);
    if (!Number.isFinite(query.agentRadius) || query.agentRadius < 0) {
      throw new Error(`NavMesh query ${corpusCase.id}/${query.id} agentRadius is invalid.`);
    }
    validateKnownIds(query.activeObstacleIds, obstacleIds, `${corpusCase.id}/${query.id} active obstacle`);
    validateKnownIds(query.ignoreObstacleIds, obstacleIds, `${corpusCase.id}/${query.id} ignored obstacle`);
    validateKnownIds(query.disabledPortalIds, portalIds, `${corpusCase.id}/${query.id} disabled portal`);
    if (!query.expected || !['complete', 'unreachable', 'invalid-start', 'invalid-target'].includes(query.expected.status)) {
      throw new Error(`NavMesh query ${corpusCase.id}/${query.id} has no valid expected status.`);
    }
    if (!regionIds.has(query.expected.startRegion) || !regionIds.has(query.expected.targetRegion)) {
      throw new Error(`NavMesh query ${corpusCase.id}/${query.id} expected regions are invalid.`);
    }
    validateKnownIds(query.expected.regionPath, regionIds, `${corpusCase.id}/${query.id} expected region`);
    validateKnownIds(query.expected.portalPath, portalIds, `${corpusCase.id}/${query.id} expected portal`);
    validateKnownIds(query.expected.blockedPortalIds, portalIds, `${corpusCase.id}/${query.id} expected blocked portal`);
    if (query.expected.obstacleRegions !== undefined) {
      if (!query.expected.obstacleRegions || Array.isArray(query.expected.obstacleRegions)
        || typeof query.expected.obstacleRegions !== 'object') {
        throw new Error(`NavMesh query ${corpusCase.id}/${query.id} expected obstacleRegions must be an object.`);
      }
      for (const [obstacleId, regionId] of Object.entries(query.expected.obstacleRegions)) {
        if (!obstacleIds.has(obstacleId) || !regionIds.has(regionId)) {
          throw new Error(`NavMesh query ${corpusCase.id}/${query.id} has an invalid expected obstacle layer.`);
        }
      }
    }
  }
}

function createCaseContext(corpusCase) {
  const basis = createPlanarBasis(corpusCase.up);
  const regions = corpusCase.regions.map(region => ({
    ...region,
    elevation: dot(region.vertices[0], corpusCase.up),
    projectedVertices: region.vertices.map(vertex => projectPoint(vertex, basis)),
  }));
  const regionsById = new Map(regions.map(region => [region.id, region]));
  const portals = [...(corpusCase.portals ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  return {
    corpusCase,
    basis,
    regions,
    regionsById,
    portals,
    obstaclesById: new Map((corpusCase.obstacles ?? []).map(obstacle => [obstacle.id, obstacle])),
  };
}

function resolvePointRegion(context, point) {
  const elevation = dot(point, context.corpusCase.up);
  const projected = projectPoint(point, context.basis);
  const candidates = context.regions
    .filter(region => (
      Math.abs(elevation - region.elevation) <= context.corpusCase.surfaceTolerance + EPSILON
      && pointInPolygon(projected, region.projectedVertices)
    ))
    .map(region => ({ region, distance: Math.abs(elevation - region.elevation) }))
    .sort((a, b) => a.distance - b.distance || a.region.id.localeCompare(b.region.id));
  if (candidates.length > 1 && Math.abs(candidates[0].distance - candidates[1].distance) <= EPSILON) {
    throw new Error(
      `Point ${JSON.stringify(point)} ambiguously resolves to ${candidates[0].region.id} and ${candidates[1].region.id}.`,
    );
  }
  return candidates[0]?.region ?? null;
}

function resolveObstacleState(context, query) {
  const activeIds = query.activeObstacleIds === undefined
    ? [...context.obstaclesById.values()].filter(obstacle => obstacle.enabled).map(obstacle => obstacle.id)
    : query.activeObstacleIds;
  const ignored = new Set(query.ignoreObstacleIds ?? []);
  const active = [];
  const regionById = {};
  for (const id of activeIds) {
    if (ignored.has(id)) continue;
    const obstacle = context.obstaclesById.get(id);
    if (!obstacle?.enabled) continue;
    const region = resolvePointRegion(context, obstacle.position);
    if (!region) throw new Error(`Dynamic obstacle ${context.corpusCase.id}/${id} does not resolve to a surface.`);
    active.push({ obstacle, region });
    regionById[id] = region.id;
  }
  return { active, regionById };
}

function collectBlockedPortalIds(context, query, obstacleState) {
  const result = new Set();
  for (const portal of context.portals) {
    for (const { obstacle, region } of obstacleState.active) {
      if (region.id !== portal.from && region.id !== portal.to) continue;
      const clearanceRadius = obstacle.radius + query.agentRadius;
      if (planarDistance(obstacle.position, portal.position, context.corpusCase.up) > clearanceRadius + EPSILON) continue;
      if (portal.width <= clearanceRadius * 2 + EPSILON) {
        result.add(portal.id);
        break;
      }
    }
  }
  return result;
}

function edgesFrom(context, regionId) {
  const edges = [];
  for (const portal of context.portals) {
    if (portal.from === regionId) edges.push({ to: portal.to, portalId: portal.id });
    if (portal.bidirectional && portal.to === regionId) edges.push({ to: portal.from, portalId: portal.id });
  }
  return edges.sort((a, b) => a.portalId.localeCompare(b.portalId) || a.to.localeCompare(b.to));
}

function compareExpected(expected, actual) {
  const mismatches = [];
  for (const key of ['status', 'startRegion', 'targetRegion']) {
    if (actual[key] !== expected[key]) mismatches.push(`${key}: expected ${expected[key]}, received ${actual[key]}`);
  }
  for (const key of ['regionPath', 'portalPath']) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) {
      mismatches.push(`${key}: expected ${JSON.stringify(expected[key])}, received ${JSON.stringify(actual[key])}`);
    }
  }
  if (expected.blockedPortalIds !== undefined
    && JSON.stringify(actual.blockedPortalIds) !== JSON.stringify(expected.blockedPortalIds)) {
    mismatches.push(
      `blockedPortalIds: expected ${JSON.stringify(expected.blockedPortalIds)}, `
      + `received ${JSON.stringify(actual.blockedPortalIds)}`,
    );
  }
  if (expected.obstacleRegions !== undefined
    && JSON.stringify(actual.obstacleRegions) !== JSON.stringify(expected.obstacleRegions)) {
    mismatches.push(
      `obstacleRegions: expected ${JSON.stringify(expected.obstacleRegions)}, `
      + `received ${JSON.stringify(actual.obstacleRegions)}`,
    );
  }
  return mismatches;
}

function createPlanarBasis(up) {
  const reference = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const axisU = normalize(cross(reference, up));
  const axisV = cross(up, axisU);
  return { axisU, axisV };
}

function projectPoint(point, basis) {
  return [dot(point, basis.axisU), dot(point, basis.axisV)];
}

function pointInPolygon(point, vertices) {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index++) {
    const a = vertices[previous];
    const b = vertices[index];
    if (pointOnSegment(point, a, b)) return true;
    const crosses = (a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointOnSegment(point, a, b) {
  const abX = b[0] - a[0];
  const abY = b[1] - a[1];
  const apX = point[0] - a[0];
  const apY = point[1] - a[1];
  const crossValue = abX * apY - abY * apX;
  if (Math.abs(crossValue) > EPSILON) return false;
  const projection = apX * abX + apY * abY;
  return projection >= -EPSILON && projection <= abX * abX + abY * abY + EPSILON;
}

function signedPolygonArea(vertices) {
  let area = 0;
  for (let index = 0; index < vertices.length; index++) {
    const next = (index + 1) % vertices.length;
    area += vertices[index][0] * vertices[next][1] - vertices[next][0] * vertices[index][1];
  }
  return area * 0.5;
}

function planarDistance(a, b, up) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  const alongUp = dx * up[0] + dy * up[1] + dz * up[2];
  return Math.hypot(
    dx - alongUp * up[0],
    dy - alongUp * up[1],
    dz - alongUp * up[2],
  );
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(vector) {
  const length = vectorLength(vector);
  if (length <= EPSILON) throw new Error('Cannot normalize a zero NavMesh vector.');
  return vector.map(value => value / length);
}

function vectorLength(vector) {
  requirePoint(vector, 'NavMesh vector');
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function requirePoint(point, label) {
  if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) {
    throw new Error(`${label} must be a finite xyz tuple.`);
  }
}

function requireUniqueId(id, ids, label) {
  if (typeof id !== 'string' || id.length === 0 || ids.has(id)) {
    throw new Error(`NavMesh ${label} id "${id}" is empty or duplicated.`);
  }
  ids.add(id);
}

function validateKnownIds(values, known, label) {
  if (values === undefined) return;
  if (!Array.isArray(values)) throw new Error(`NavMesh ${label} ids must be an array.`);
  for (const id of values) {
    if (!known.has(id)) throw new Error(`Unknown NavMesh ${label} id "${id}".`);
  }
}
