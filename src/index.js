import mediaQuery from "css-mediaquery";
import transformCSS from "@cssxjs/css-to-react-native";
import parseCSS from "css/lib/parse";
import {
  dimensionFeatures,
  mediaQueryFeatures,
} from "./transforms/media-queries/features";
import { mediaQueryTypes } from "./transforms/media-queries/types";
import { remToPx } from "./transforms/rem";
import { allEqual } from "./utils/allEqual";
import { camelCase } from "./utils/camelCase";
import { sortRules } from "./utils/sortRules";
import { values } from "./utils/values";

const lengthRe = /^(0$|(?:[+-]?(?:\d*\.)?\d+(?:[Ee][+-]?\d+)?)(?=px|rem$))/;
const viewportUnitRe = /^([+-]?[0-9.]+)(vh|vw|vmin|vmax)$/;
const percentRe = /^([+-]?(?:\d*\.)?\d+(?:[Ee][+-]?\d+)?%)$/;
const unsupportedUnitRe = /^([+-]?(?:\d*\.)?\d+(?:[Ee][+-]?\d+)?(ch|em|ex|cm|mm|in|pc|pt))$/;
const cssPartRe = /::?part\(([^)]+)\)/;
const rootRe = /:root/;
const shorthandBorderProps = [
  "border-radius",
  "border-width",
  "border-color",
  "border-style",
];

/**
 * Extracts @keyframes from CSS and returns the cleaned CSS and keyframes object
 * @param {string} css - The input CSS string
 * @returns {{css: string, keyframes: Object}} - Cleaned CSS and keyframes object
 */
const extractKeyframes = (css) => {
  const keyframes = {};
  let cleanedCss = css;

  // Find @keyframes by manually parsing to handle nested braces
  let index = 0;
  while (index < css.length) {
    const keyframesMatch = css.slice(index).match(/@keyframes\s+([^\s{]+)\s*{/);
    if (!keyframesMatch) break;

    const startIndex = index + keyframesMatch.index;
    const nameEndIndex = startIndex + keyframesMatch[0].length;
    const name = keyframesMatch[1];

    // Find the matching closing brace
    let braceCount = 1;
    let currentIndex = nameEndIndex;
    while (currentIndex < css.length && braceCount > 0) {
      if (css[currentIndex] === '{') {
        braceCount++;
      } else if (css[currentIndex] === '}') {
        braceCount--;
      }
      currentIndex++;
    }

    if (braceCount === 0) {
      // Extract the body (without the outer braces)
      const body = css.slice(nameEndIndex, currentIndex - 1).trim();
      keyframes[name] = body;

      // Mark for removal by replacing with spaces to maintain positions
      const fullKeyframe = css.slice(startIndex, currentIndex);
      cleanedCss = cleanedCss.replace(fullKeyframe, '');
    }

    index = currentIndex;
  }

  return { css: cleanedCss, keyframes };
};

const transformDecls = (styles, declarations, result, keyframes) => {
  for (const d in declarations) {
    const declaration = declarations[d];
    if (declaration.type !== "declaration") continue;

    const property = declaration.property;
    const value = remToPx(declaration.value);

    const isLengthUnit = lengthRe.test(value);
    const isViewportUnit = viewportUnitRe.test(value);
    const isPercent = percentRe.test(value);
    const isUnsupportedUnit = unsupportedUnitRe.test(value);

    if (
      property === "line-height" &&
      !isLengthUnit &&
      !isViewportUnit &&
      !isPercent &&
      !isUnsupportedUnit
    ) {
      throw new Error(`Failed to parse declaration "${property}: ${value}"`);
    }

    if (!result.__viewportUnits && isViewportUnit) {
      result.__viewportUnits = true;
    }

    if (shorthandBorderProps.indexOf(property) > -1) {
      // transform single value shorthand border properties back to
      // shorthand form to support styling `Image`.
      const transformed = transformCSS([[property, value]]);
      const vals = values(transformed);
      if (allEqual(vals)) {
        const replacement = {};
        replacement[camelCase(property)] = vals[0];
        Object.assign(styles, replacement);
      } else {
        Object.assign(styles, transformed);
      }
    } else if (['animation', 'animation-name'].includes(property) && keyframes && Object.keys(keyframes).length > 0) {
      // Pass all keyframes to transformCSS - it will figure out which ones to use
      const keyframeDeclarations = [];
      for (const name in keyframes) {
        keyframeDeclarations.push(['@keyframes ' + name, keyframes[name]]);
      }
      const transformed = transformCSS([
        ...keyframeDeclarations,
        [property, value]
      ]);
      Object.assign(styles, transformed);
    } else {
      Object.assign(styles, transformCSS([[property, value]]));
    }
  }
};

const transform = (css, options) => {
  // Extract keyframes and store them separately, before parsing (remove them from css)
  let keyframes;
  if (options?.parseKeyframes) {
    ({ css, keyframes } = extractKeyframes(css));
  }

  const { stylesheet } = parseCSS(css);
  const rules = sortRules(stylesheet.rules);

  const result = {};

  for (const r in rules) {
    const rule = rules[r];
    for (const s in rule.selectors) {
      if (rule.selectors[s] === ":export") {
        if (!result.__exportProps) {
          result.__exportProps = {};
        }

        rule.declarations.forEach(({ property, value }) => {
          const isAlreadyDefinedAsClass =
            result[property] !== undefined &&
            result.__exportProps[property] === undefined;

          if (isAlreadyDefinedAsClass) {
            throw new Error(
              `Failed to parse :export block because a CSS class in the same file is already using the name "${property}"`,
            );
          }

          result.__exportProps[property] = value;
        });
        continue;
      }

      if (
        rootRe.test(rule.selectors[s])
          ? false
          : rule.selectors[s].indexOf(".") !== 0 ||
            (rule.selectors[s].indexOf(":") !== -1 &&
              (options != null && options.parsePartSelectors
                ? !cssPartRe.test(rule.selectors[s])
                : true)) ||
            rule.selectors[s].indexOf("[") !== -1 ||
            rule.selectors[s].indexOf("~") !== -1 ||
            rule.selectors[s].indexOf(">") !== -1 ||
            rule.selectors[s].indexOf("+") !== -1 ||
            rule.selectors[s].indexOf(" ") !== -1
      ) {
        continue;
      }

      if (
        typeof options?.ignoreRule === "function" &&
        options.ignoreRule(rule.selectors[s]) === true
      ) {
        continue;
      }

      const selector = rule.selectors[s].replace(/^\./, "");
      const styles = (result[selector] = result[selector] || {});
      transformDecls(styles, rule.declarations, result, keyframes);
    }

    if (
      rule.type == "media" &&
      options != null &&
      options.parseMediaQueries === true
    ) {
      const parsed = mediaQuery.parse(rule.media);

      parsed.forEach(mq => {
        if (mediaQueryTypes.indexOf(mq.type) === -1) {
          throw new Error(`Failed to parse media query type "${mq.type}"`);
        }

        mq.expressions.forEach(e => {
          const mf = e.modifier ? `${e.modifier}-${e.feature}` : e.feature;
          const val = e.value ? `: ${e.value}` : "";

          if (mediaQueryFeatures.indexOf(e.feature) === -1) {
            throw new Error(`Failed to parse media query feature "${mf}"`);
          }

          if (
            dimensionFeatures.indexOf(e.feature) > -1 &&
            lengthRe.test(e.value) === false
          ) {
            throw new Error(
              `Failed to parse media query expression "(${mf}${val})"`,
            );
          }
        });
      });

      const media = "@media " + rule.media;

      result.__mediaQueries = result.__mediaQueries || {};
      result.__mediaQueries[media] = parsed;

      for (const r in rule.rules) {
        const ruleRule = rule.rules[r];
        for (const s in ruleRule.selectors) {
          if (
            typeof options?.ignoreRule === "function" &&
            options.ignoreRule(ruleRule.selectors[s]) === true
          ) {
            continue;
          }

          result[media] = result[media] || {};
          const selector = ruleRule.selectors[s].replace(/^\./, "");
          const mediaStyles = (result[media][selector] =
            result[media][selector] || {});
          transformDecls(mediaStyles, ruleRule.declarations, result, keyframes);
        }
      }
    }
  }

  if (result.__exportProps) {
    if (Object.keys(result.__exportProps).length === 0) {
      delete result.__exportProps;
    } else {
      Object.assign(result, result.__exportProps);
    }
  }

  return result;
};

export default transform;
