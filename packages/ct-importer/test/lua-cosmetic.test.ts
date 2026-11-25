import { describe, it, expect } from 'vitest';
import { isCosmeticLua } from '../src/lua-cosmetic.js';

describe('isCosmeticLua', () => {
  it('accepts links, messages and the syntaxcheck guard', () => {
    expect(isCosmeticLua('')).toBe(true);
    expect(isCosmeticLua('-- only a comment\n--[[ and a block ]]')).toBe(true);
    expect(isCosmeticLua("if syntaxcheck then return end\n[ENABLE]\nShellExecute('https://a.b/?x=1')\n[DISABLE]")).toBe(true);
    expect(isCosmeticLua('if messageDialog("Open? a=b", mtConfirmation, mbYes, mbNo) == mrYes then shellExecute("u") else end')).toBe(true);
    expect(isCosmeticLua('getMainForm().CommentButton.doClick()')).toBe(true);
  });

  it("accepts the Compact View Mode snippet, which only changes CE's window", () => {
    const compact = "function cycleFullCompact(sender,force) local state = not(compactmenuitem.Caption == 'Compact View Mode'); "
      + "if force~=nil then state = not force end; compactmenuitem.Caption = state and 'Compact View Mode' or 'Full View Mode'; "
      + 'getMainForm().Splitter1.Visible = state; getMainForm().Panel4.Visible = state; getMainForm().Panel5.Visible = state; end; '
      + 'function addCompactMenu() if compactmenualreadyexists then return end; local parent = getMainForm().Menu.Items; '
      + "compactmenuitem = createMenuItem(parent); parent.add(compactmenuitem); compactmenuitem.Caption = 'Compact View Mode'; "
      + "compactmenuitem.OnClick = cycleFullCompact; compactmenualreadyexists = 'yes'; end; addCompactMenu(); cycleFullCompact(nil,true)";
    expect(isCosmeticLua(compact)).toBe(true);
    expect(isCosmeticLua(compact + '; writeInteger(state, 1)')).toBe(false);
  });

  it('rejects anything that touches the game or the table', () => {
    expect(isCosmeticLua('writeInteger("iEnableGMD",0)')).toBe(false);
    expect(isCosmeticLua('memrec.Color=0x0c08000')).toBe(false);
    expect(isCosmeticLua('local x = 1')).toBe(false);
    expect(isCosmeticLua('mono_initialize()')).toBe(false);
    expect(isCosmeticLua('ShellExecute(getAddress("x"))')).toBe(false);
  });
});
