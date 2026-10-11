import * as assert from "assert";
import { parseHoi4File } from "../hoiformat/hoiparser";
import { buildModifierLocalisationKeys } from "../inlayhint/modifierInlayHint";
import {
	ModifierDefinitions,
	formatModifierValue,
	formatResearchBonuses,
	humaniseKey,
	modifierKeysFromLocalisationKeys,
	readModifierDefinitions,
	readModifierFormats,
	resolveDefinition,
	resolvePreviewModifierName,
	toneFor,
} from "../util/modifiers";

// The definitions below are transcribed from Millennium Dawn's
// common/modifier_definitions/political_modifier_definitions.txt and the vanilla
// lar_operation_modifiers_pre_definition.txt.
//
// The two halves of this module are tested apart: what a mod wrote down, which must be obeyed
// exactly, and what has to be guessed for the modifiers the game defines internally and no file
// describes.

function definitionsOf(input: string): ModifierDefinitions {
	return readModifierDefinitions(parseHoi4File(input));
}

describe("previewdef/idea/modifiers definitions", () => {
	it("reads every field a definition can carry", () => {
		const definitions = definitionsOf(`
            operation_cost = {
                color_type = bad
                value_type = percentage
                precision = 0
                category = intelligence_agency
            }
        `);

		assert.deepStrictEqual(definitions["operation_cost"], {
			colorType: "bad",
			valueType: "percentage",
			precision: 0,
			postfix: "none",
		});
	});

	it("falls back to the game's own defaults for fields a definition leaves out", () => {
		const definitions = definitionsOf(`popularity_attack_modifier = { color_type = good }`);

		assert.deepStrictEqual(definitions["popularity_attack_modifier"], {
			colorType: "good",
			valueType: "number",
			precision: 2,
			postfix: "none",
		});
	});

	it("ignores a value that is not one the game accepts", () => {
		const definitions = definitionsOf(`
            odd = { value_type = furlongs color_type = purple postfix = fortnights }
        `);

		assert.deepStrictEqual(definitions["odd"], {
			colorType: "bad",
			valueType: "number",
			precision: 2,
			postfix: "none",
		});
	});
});

describe("previewdef/idea/modifiers resolution", () => {
	const definitions = definitionsOf(`
        productivity_growth_modifier = { color_type = good value_type = number precision = 2 }
    `);

	// The point of reading common/modifier_definitions at all: the _factor guess would call this a
	// percentage and show "-400%" where the game shows "-4.00".
	it("obeys a definition rather than guessing", () => {
		assert.strictEqual(
			resolveDefinition("productivity_growth_modifier", definitions).valueType,
			"number",
		);
	});

	it("reads an undefined _factor modifier as a percentage", () => {
		assert.strictEqual(resolveDefinition("stability_factor", {}).valueType, "percentage");
	});

	it("reads any other undefined modifier as a plain number", () => {
		assert.strictEqual(resolveDefinition("political_power_gain", {}).valueType, "number");
	});

	// The curated table exists for the modifiers the game shows as a percentage without the suffix
	// that would give it away.
	it("applies the override table to a built-in the suffix rule misses", () => {
		assert.strictEqual(resolveDefinition("monthly_population", {}).valueType, "percentage");
		assert.strictEqual(
			resolveDefinition("industrial_capacity_factory", {}).valueType,
			"percentage",
		);
		assert.strictEqual(resolveDefinition("conscription", {}).valueType, "percentage");
	});

	// A file the mod wrote about the same key wins over the curated guess, which is only ever a
	// stand-in for a file that does not exist.
	it("lets a definition beat the override table", () => {
		const definitions = definitionsOf(`conscription = { value_type = number precision = 3 }`);
		assert.strictEqual(resolveDefinition("conscription", definitions).valueType, "number");
		assert.strictEqual(resolveDefinition("conscription", definitions).precision, 3);
	});
});

// What a modifier is called on a card. Vanilla spells the key shapes inconsistently: most modifiers
// are localised under MODIFIER_<KEY IN CAPITALS>, building and production modifiers under
// modifier_<key>, a few are named only by a <key>_tt tooltip, and a modifier defined in
// common/modifier_definitions is localised under its own bare token. Missing any one of them shows
// the key spaced out in capitals, which reads as an untranslated card.
describe("previewdef/idea/modifiers localised names", () => {
	function lookupOf(entries: Record<string, string>): (key: string) => string | undefined {
		return (key) => entries[key];
	}

	it("resolves every key shape vanilla writes", () => {
		const lookup = lookupOf({
			MODIFIER_STABILITY_FACTOR: "Stability",
			modifier_production_speed_industrial_complex_factor: "Civilian Factory construction speed",
			monthly_population_tt: " $MODIFIER_GLOBAL_MONTHLY_POPULATION$: $RIGHT|+=%1$",
			MODIFIER_GLOBAL_MONTHLY_POPULATION: "Monthly Population",
			operation_cost: "Operation cost",
		});

		assert.strictEqual(resolvePreviewModifierName("stability_factor", lookup), "Stability");
		assert.strictEqual(
			resolvePreviewModifierName("production_speed_industrial_complex_factor", lookup),
			"Civilian Factory construction speed",
		);
		// Only the tooltip names this one, and it names the key that carries the text.
		assert.strictEqual(resolvePreviewModifierName("monthly_population", lookup), "Monthly Population");
		// A modifier a mod defines is localised under its own token.
		assert.strictEqual(resolvePreviewModifierName("operation_cost", lookup), "Operation cost");
	});

	it("prefers the MODIFIERS_ shape the game's tooltips reference", () => {
		const lookup = lookupOf({
			MODIFIERS_WAR_SUPPORT_FACTOR: "War Support",
			MODIFIER_WAR_SUPPORT_FACTOR: "War support, singular",
		});
		assert.strictEqual(resolvePreviewModifierName("war_support_factor", lookup), "War Support");
	});

	// A localisation value carries the game's colour codes and icon tokens; a card shows neither.
	it("cleans the value it shows", () => {
		const lookup = lookupOf({
			modifier_production_speed_industrial_complex_factor: "§Y民用工厂§!建设速度",
			MODIFIER_PRODUCTION_FACTORY_EFFICIENCY_GAIN_FACTOR: "£prod_eff 生产效率增长",
		});

		assert.strictEqual(
			resolvePreviewModifierName("production_speed_industrial_complex_factor", lookup),
			"民用工厂建设速度",
		);
		assert.strictEqual(
			resolvePreviewModifierName("production_factory_efficiency_gain_factor", lookup),
			"生产效率增长",
		);
	});

	it("reports a modifier nothing localises, so the caller humanises the key", () => {
		assert.strictEqual(resolvePreviewModifierName("nothing_localises_this", lookupOf({})), undefined);
	});

	// A few modifiers the game files under a key that is not their own name — Paradox abbreviated it
	// for the military-industrial-organization costs and added a qualifier to the refit one. The
	// mapping sits in the executable, so the shapes list carries it.
	it("looks a modifier up under the key the game files it under", () => {
		const lookup = lookupOf({
			MODIFIER_INDUSTRIAL_REFIT_IC_COST_FACTOR: "舰艇改装花费",
			MODIFIER_MIO_DESIGN_TEAM_ASSIGN_COST: "Design Team Assign Cost",
		});

		assert.strictEqual(buildModifierLocalisationKeys("refit_ic_cost")[0], "MODIFIER_INDUSTRIAL_REFIT_IC_COST_FACTOR");
		assert.strictEqual(resolvePreviewModifierName("refit_ic_cost", lookup), "舰艇改装花费");
		assert.strictEqual(
			resolvePreviewModifierName("military_industrial_organization_design_team_assign_cost", lookup),
			"Design Team Assign Cost",
		);
	});

	// `" £icon_token "` is an icon and nothing else, so it names no modifier: ending the search there
	// would put an empty name on the card, and the next shape has to get its turn.
	it("keeps looking past a value that is only an icon", () => {
		const lookup = lookupOf({
			MODIFIERS_ICON_ONLY_FACTOR: " £icon_token ",
			modifier_icon_only_factor: "Icon Only",
		});

		assert.strictEqual(resolvePreviewModifierName("icon_only_factor", lookup), "Icon Only");
		assert.strictEqual(
			resolvePreviewModifierName("icon_only_factor", lookupOf({ MODIFIERS_ICON_ONLY_FACTOR: " £icon_token " })),
			undefined,
		);
	});
});

// The picker offers the keys the localisation entries spell out. Vanilla names most modifiers
// MODIFIER_<KEY> and the building and production ones modifier_<key>; taking only the upper-case
// shape left the lower-case keys out of the list, which is what made the edit dialog show a raw key
// such as production_speed_arms_factory_factor instead of its name.
describe("previewdef/idea/modifiers pickable keys", () => {
	it("takes both the upper-case and the lower-case key shapes", () => {
		const keys = modifierKeysFromLocalisationKeys([
			"MODIFIER_STABILITY_FACTOR",
			"MODIFIERS_WAR_SUPPORT_FACTOR",
			"modifier_production_speed_arms_factory_factor",
			"modifier_production_speed_arms_factory_factor_desc",
			"UNRELATED_KEY",
		]);

		assert.deepStrictEqual(keys.sort(), [
			"production_speed_arms_factory_factor",
			"production_speed_arms_factory_factor_desc",
			"stability_factor",
			"war_support_factor",
		]);
	});

	it("counts one key once when several shapes spell it", () => {
		assert.deepStrictEqual(
			modifierKeysFromLocalisationKeys(["MODIFIER_STABILITY_FACTOR", "modifier_stability_factor"]),
			["stability_factor"],
		);
	});
});

describe("previewdef/idea/modifiers value formatting", () => {
	const percentage = resolveDefinition("stability_factor", {});
	const number = resolveDefinition("political_power_gain", {});

	it("scales a percentage and writes the sign", () => {
		assert.strictEqual(formatModifierValue(-0.1, percentage), "-10%");
		assert.strictEqual(formatModifierValue(0.25, percentage), "+25%");
	});

	it("leaves a plain number unscaled", () => {
		assert.strictEqual(formatModifierValue(-4, number), "-4");
		assert.strictEqual(formatModifierValue(0.3, number), "+0.3");
	});

	// percentage_in_hundred is already out of a hundred, so multiplying would be wrong twice over.
	it("does not scale percentage_in_hundred", () => {
		const definition = { ...percentage, valueType: "percentage_in_hundred" as const };
		assert.strictEqual(formatModifierValue(25, definition), "+25%");
	});

	it("trims trailing zeroes without eating the number", () => {
		assert.strictEqual(formatModifierValue(2, number), "+2");
		assert.strictEqual(formatModifierValue(0, number), "0");
		assert.strictEqual(formatModifierValue(0.5, number), "+0.5");
	});

	it("honours the precision a definition asked for", () => {
		assert.strictEqual(
			formatModifierValue(0.12345, { ...percentage, precision: 0 }),
			"+12%",
		);
	});

	it("writes a postfix the definition asked for", () => {
		assert.strictEqual(
			formatModifierValue(3, { ...number, postfix: "days" }),
			"+3 days",
		);
	});

	it("says yes or no rather than a number", () => {
		assert.strictEqual(formatModifierValue(true, number), "yes");
		assert.strictEqual(
			formatModifierValue(1, { ...number, valueType: "yes_no" }),
			"yes",
		);
		assert.strictEqual(
			formatModifierValue(0, { ...number, valueType: "yes_no" }),
			"no",
		);
	});

	// A `@constant` or a variable reference has no number to scale, so it is shown as written rather
	// than dropped.
	it("shows a symbol value as it was written", () => {
		assert.strictEqual(formatModifierValue("@stability_hit", number), "@stability_hit");
	});
});

describe("previewdef/idea/modifiers tone", () => {
	const plain = resolveDefinition("political_power_gain", {});

	it("reads a positive number as good and a negative one as bad", () => {
		assert.strictEqual(toneFor("political_power_gain", 0.3, plain, false), "good");
		assert.strictEqual(toneFor("political_power_gain", -0.3, plain, false), "bad");
	});

	it("colours nothing when the value is zero or not a number", () => {
		assert.strictEqual(toneFor("political_power_gain", 0, plain, false), "neutral");
		assert.strictEqual(toneFor("cant_send_volunteers", true, plain, false), "neutral");
	});

	// Cheaper is better, so the sign alone would colour these backwards.
	it("inverts the sign for a modifier where less is better", () => {
		const definition = resolveDefinition("production_cost_factor", {});
		assert.strictEqual(toneFor("production_cost_factor", -0.1, definition, false), "good");
		assert.strictEqual(toneFor("production_cost_factor", 0.1, definition, false), "bad");
		assert.strictEqual(toneFor("consumer_goods_factor", -0.05, definition, false), "good");
	});

	it("lets a definition's color_type decide which direction is good", () => {
		const definitions = definitionsOf(`operation_cost = { color_type = bad }`);
		const definition = resolveDefinition("operation_cost", definitions);
		assert.strictEqual(toneFor("operation_cost", -0.2, definition, true), "good");
		assert.strictEqual(toneFor("operation_cost", 0.2, definition, true), "bad");
	});

	// color_type neutral says the modifier has no inherent direction, not that its value cannot be
	// read, so it falls through to the sign rule rather than blanking the colour.
	it("falls back to the sign when a definition says the modifier is neutral", () => {
		const definitions = definitionsOf(`middling = { color_type = neutral }`);
		const definition = resolveDefinition("middling", definitions);
		assert.strictEqual(toneFor("middling", 0.2, definition, true), "good");
		assert.strictEqual(toneFor("middling", -0.2, definition, true), "bad");
	});
});

// The exception tables were first chosen from Millennium Dawn only. These are base-game national
// spirit modifiers, read as the game shows them. Issue #453.
describe("previewdef/idea/modifiers base-game formats", () => {
	function line(key: string, value: number): [string, string] {
		const definition = resolveDefinition(key, {});
		return [formatModifierValue(value, definition), toneFor(key, value, definition, false)];
	}

	it("shows the base game's fraction-written modifiers as percentages", () => {
		assert.deepStrictEqual(line("non_core_manpower", 0.02), ["+2%", "good"]);
		assert.deepStrictEqual(line("mobilization_speed", 0.2), ["+20%", "good"]);
		assert.deepStrictEqual(line("command_power_gain_mult", 0.1), ["+10%", "good"]);
		assert.deepStrictEqual(line("army_org_regain", 0.1), ["+10%", "good"]);
		assert.deepStrictEqual(line("naval_coordination", 0.25), ["+25%", "good"]);
	});

	it("colours the base game's lower-is-better modifiers by what they cost", () => {
		assert.deepStrictEqual(line("send_volunteers_tension", -0.5), ["-50%", "good"]);
		assert.deepStrictEqual(line("generate_wargoal_tension", -0.25), ["-25%", "good"]);
		assert.deepStrictEqual(line("license_purchase_cost", -0.3), ["-30%", "good"]);
		assert.deepStrictEqual(line("subversive_activites_upkeep", -0.5), ["-50%", "good"]);
		assert.deepStrictEqual(line("resistance_target", 0.1), ["+10%", "bad"]);
		assert.deepStrictEqual(line("air_night_penalty", -0.05), ["-5%", "good"]);
		assert.deepStrictEqual(line("political_power_cost", 0.2), ["+0.2", "bad"]);
	});

	// These read the other way: they work against whoever occupies our states.
	it("keeps the sign rule for resistance in our own occupied states", () => {
		assert.deepStrictEqual(line("resistance_target_on_our_occupied_states", 0.25), ["+25%", "good"]);
		assert.deepStrictEqual(line("enemy_justify_war_goal_time", 0.3), ["+30%", "good"]);
	});

	it("leaves the flat daily modifiers as plain numbers", () => {
		assert.deepStrictEqual(line("political_power_gain", 0.1), ["+0.1", "good"]);
		assert.deepStrictEqual(line("fascism_drift", 0.03), ["+0.03", "good"]);
		assert.deepStrictEqual(line("command_power_gain", 0.2), ["+0.2", "good"]);
	});
});

describe("previewdef/idea/modifiers format files", () => {
	it("reads only the fields an entry writes", () => {
		assert.deepStrictEqual(
			readModifierFormats(parseHoi4File(`
				political_power_gain = { value_type = percentage }
				odd = { value_type = furlongs precision = 1 }
			`)),
			{
				political_power_gain: { valueType: "percentage" },
				odd: { precision: 1 },
			},
		);
	});
});

describe("previewdef/idea/modifiers research bonuses", () => {
	// A research_bonus value is always a factor, whatever the category is called, so the _factor
	// suffix rule that governs modifiers has nothing to say here.
	it("reads every research bonus as a percentage", async () => {
		const lines = await formatResearchBonuses([
			{ key: "CAT_fuel_oil", value: 0.05 },
			{ key: "armor", value: 0.1 },
		]);

		assert.deepStrictEqual(
			lines.map((l) => [l.key, l.value, l.tone]),
			[
				["CAT_fuel_oil", "+5%", "good"],
				["armor", "+10%", "good"],
			],
		);
	});

	it("reads a negative research bonus as bad", async () => {
		const lines = await formatResearchBonuses([{ key: "armor", value: -0.1 }]);
		assert.strictEqual(lines[0]?.tone, "bad");
	});

	it("makes the category readable when nothing localises it", async () => {
		const lines = await formatResearchBonuses([{ key: "CAT_fuel_oil", value: 0.05 }]);
		assert.strictEqual(lines[0]?.name, "CAT_fuel_oil".replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
	});
});

describe("previewdef/idea/modifiers naming", () => {
	it("makes a raw key readable when nothing localises it", () => {
		assert.strictEqual(humaniseKey("stability_factor"), "Stability Factor");
		assert.strictEqual(
			humaniseKey("production_speed_buildings_factor"),
			"Production Speed Buildings Factor",
		);
	});
});
