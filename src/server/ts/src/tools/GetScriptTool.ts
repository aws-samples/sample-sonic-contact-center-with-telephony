import { Tool } from "./Tool";

export class GetScriptTool extends Tool {
  public static id = "getscript";
  public static schema = {
    type: "object",
    properties: {
      number: {
        type: "number",
        description: "The number used to identify the file to fetch",
      },
    },
    required: ["number"],
  };
  public static toolSpec = {
    toolSpec: {
      name: GetScriptTool.id,
      description: "Use this tool to find out what you should say to the user",
      inputSchema: {
        json: JSON.stringify(GetScriptTool.schema),
      },
    },
  };

  public static async execute(toolUseContent, messagesList: string[]): Promise<any> {
    let n: number = JSON.parse(toolUseContent.content)?.number;
    if (!n) {
      n = 0;
    }
    console.log("n", n);
    const scripts = [
      "",
      "You are in a dungeon. You don't know how you got here. It's pitch black but you can feel some objects lying by your side... OPTION 2: Pick up the sharp object; OPTION 3: Pick up the heavy object",
      "You cut yourself on the sharp object. You eventually realize it's a sword, and gently find the handle to grasp it. But you find another hand already there - IT'S A LIVE ORC! OPTION 4: Fight for the sword; OPTION 5: Sucker punch it",
      "You pick up a bag full of items. Inside it, you see a map, a compass, and a large orb of solid diamond. Sweet! The map leads you to the exit of the cave, but it seems to be blocked by a boulder. OPTION 6: Roll it away; OPTION 7: Try to smash it with the diamond orb",
      "You fight for the sword but the orc wins. He stabs you in the gut. You keel over and die. OPTION 8: Restart your adventure; OPTION 9: Accept your fate",
      "You sucker punch the orc in the face, causing it to drop the sword. You take your chance and point the sword at its neck. OPTION 10: Kill it; OPTION 11: Spare its life",
      "You roll the boulder away but to your surprise it wasn't covering a door, it was covering a rope ladder! OPTION 12: Climb up the ladder; OPTION 13: Climb down the ladder",
      "You hit the rock hard, and it cracks open to reveal a hoard of gold! The rocks are still blocking your path. OPTION 14: Stuff the gold in your bag; OPTION 15: Ignore it for now and clear the pieces of boulder out of the way",
      "As death takes you, a strange force pulls you back. You awaken at the entrance of the dungeon, memories intact. OPTION 16: Try the sharp object again; OPTION 17: Try the heavy object this time",
      "Your spirit wanders the dungeon forever. In the darkness, you become one with the shadows, a ghost haunting these halls for eternity. OPTION 18: Haunt the next adventurer; OPTION 19: Search for others like you",
      "You kill the orc with a swift strike. Searching its body, you find a rusty key. OPTION 20: Continue deeper into the dungeon; OPTION 21: Look for what the key might open",
      "You spare the orc's life. Surprisingly, it grunts and motions for you to follow. OPTION 22: Follow the orc; OPTION 23: Refuse and find your own way",
      "The ladder leads up to a trapdoor. You push it open and emerge in a sunlit forest clearing. Freedom! But you hear voices nearby. OPTION 24: Hide and observe; OPTION 25: Announce your presence",
      "You descend into a crystalline cavern, the walls sparkling with embedded gems. A narrow passage continues downward. OPTION 26: Mine some gems; OPTION 27: Explore deeper",
      "You fill your bag with gold, but the weight slows you down. As you try to move the boulder pieces, you hear growling behind you. OPTION 28: Abandon some gold to move faster; OPTION 29: Stand your ground with the heavy bag",
      "You clear the path and continue on, leaving the gold behind. The tunnel opens into a vast underground city, abandoned but intact. OPTION 30: Search for valuable artifacts; OPTION 31: Look for survivors",
      "You try the sharp object again, more carefully this time. It's definitely a sword, but something else moves in the darkness. OPTION 32: Call out; OPTION 33: Stay silent and prepare to strike",
      "The heavy object turns out to be a magical staff. As you grip it, it begins to glow, illuminating the dungeon. OPTION 34: Examine the runes on the staff; OPTION 35: Use the light to explore your surroundings",
      "You decide to haunt the next unfortunate soul who enters this dungeon. Years pass before a young knight arrives. OPTION 36: Possess the knight; OPTION 37: Guide the knight to freedom",
      "In the ethereal realm between life and death, you discover other lost souls. They tell of a ritual to return to life. OPTION 38: Attempt the ritual; OPTION 39: Learn more about the dungeon's secrets",
      "You venture deeper into the dungeon, sword in hand. The passage narrows and you hear strange chittering sounds ahead. OPTION 40: Proceed cautiously; OPTION 41: Find an alternate route",
      "You try various doors until the rusty key fits in an ancient lock. The door creaks open revealing a library filled with forbidden knowledge. OPTION 42: Study the ancient tomes; OPTION 43: Look for more practical treasures",
      "The orc leads you through a series of tunnels you would never have found on your own. You emerge in a hidden orc settlement. OPTION 44: Try to communicate peacefully; OPTION 45: Prepare for trouble",
      "You refuse to follow the orc and wander alone. The passage splits three ways, but two are collapsed. OPTION 46: Take the only open path; OPTION 47: Try to clear one of the collapsed tunnels",
      "Hidden in the underbrush, you observe a group of elven rangers discussing a reward for clearing the dungeon of monsters. OPTION 48: Reveal yourself and claim you've killed monsters; OPTION 49: Follow them secretly",
      "You step into the clearing and announce yourself. The elven rangers immediately draw their bows. OPTION 50: Drop your weapons; OPTION 51: Explain your dungeon escape",
      "You spend hours mining gems of all colors and sizes. Your bag is now worth a fortune, but you've made a lot of noise. OPTION 52: Try to quietly leave; OPTION 53: Set up traps in case something heard you",
      "The deeper passage leads to an underground lake. A boat is moored at a small dock, and faint lights shine from an island in the center. OPTION 54: Take the boat to the island; OPTION 55: Follow the shoreline",
      "You drop some gold and move quickly. Behind you, a pack of subterranean wolves rushes to investigate the noise. OPTION 56: Hide and let them pass; OPTION 57: Continue running",
      "You stand your ground as three large wolves emerge from the shadows. The sword gleams in your hand. OPTION 58: Try to intimidate them; OPTION 59: Attack the leader",
      "Among the ancient artifacts, you find a crown that whispers secrets when placed on your head. OPTION 60: Wear the crown; OPTION 61: Pack it away and continue exploring",
      "In a sealed chamber, you find a single survivor in suspended animation. A control panel blinks nearby. OPTION 62: Wake the survivor; OPTION 63: Leave them be and explore elsewhere",
      "You call out and a friendly voice responds. It's another adventurer who's been trapped here for days. OPTION 64: Join forces; OPTION 65: Be wary - it could be a trap",
      "Staying silent, you grip the sword tightly. A moment later, a goblin scout stumbles upon you in the darkness. OPTION 66: Strike first; OPTION 67: Try to communicate",
      "The runes on the staff depict an ancient binding spell. This was once used to contain a powerful entity. OPTION 68: Try to understand the binding spell; OPTION 69: Use the staff as a simple weapon and light source",
      "The staff illuminates a chamber filled with strange machinery. This appears to be some kind of control room. OPTION 70: Examine the controls; OPTION 71: Look for an exit",
      "You attempt to possess the knight but discover too late that he wears protective amulets. His priest companion begins an exorcism. OPTION 72: Resist the exorcism; OPTION 73: Flee deeper into the dungeon",
      "You appear to the knight as a ghostly guide, leading him through the dungeon's dangers. He follows cautiously. OPTION 74: Lead him to treasure; OPTION 75: Lead him to the dungeon's exit",
      "The ritual requires rare components scattered throughout the dungeon. The spirits give you temporary corporeal form to collect them. OPTION 76: Seek the heart of a monster; OPTION 77: Find the tears of a pure soul",
      "The spirits reveal that this dungeon was once a prison for an ancient evil. The seals are weakening. OPTION 78: Help strengthen the seals; OPTION 79: Learn how to escape before the evil awakens",
      "Moving slowly, you enter a massive chamber filled with giant spider webs. Cocooned figures hang from the ceiling. OPTION 80: Cut down a cocoon; OPTION 81: Sneak past to the other side",
      "You detect movement above. Looking up, you see giant spiders descending. OPTION 82: Run for it; OPTION 83: Hide and let them pass",
      "The tomes contain powerful spells but reading them aloud might be dangerous. OPTION 84: Learn a spell of opening; OPTION 85: Learn a spell of destruction",
      "Behind a hidden panel, you find a map showing all dungeon levels and a magical compass that points to your deepest desire. OPTION 86: Use them to find treasure; OPTION 87: Use them to find the exit",
      "The orcs welcome you cautiously. Their chieftain offers a deal: help them fight the dungeon's true master and they'll show you the way out. OPTION 88: Accept the deal; OPTION 89: Negotiate better terms",
      "The orcs seem agitated by your weapons. Their leader approaches, hand outstretched for your sword. OPTION 90: Surrender your weapon; OPTION 91: Refuse and prepare for battle",
      "The open path leads to a chamber with a magical portal swirling with energy. OPTION 92: Step through the portal; OPTION 93: Examine the portal's control mechanism",
      "You try to clear the rubble but trigger a secondary collapse. Water begins flooding in from somewhere. OPTION 94: Try to swim through the flooded tunnel; OPTION 95: Hurry back the way you came",
      "The elves are impressed by your claims. They offer to escort you to their village for a reward. OPTION 96: Go with them; OPTION 97: Admit you were exaggerating",
      "Following the elves, you learn they plan to collapse the dungeon entrance once their scout returns. OPTION 98: Warn the scout if you find them; OPTION 99: Keep this information to yourself",
      "You drop your weapons. The elves cautiously approach and bind your hands. OPTION 100: Cooperate and explain your situation; OPTION 1: Try to escape at the first opportunity",
    ];
    const content = scripts[n];
    console.log("content", content)
    return {
      content: content,
    };
  }
}

export default GetScriptTool;
