{
  config,
  inputs,
  lib,
  pkgs,
  ...
}: {
  overlays = [inputs.js-toolchain-overlay.overlays.default];

  languages = {
    javascript = {
      enable = true;
      package = pkgs.node-bin.lts;
      nodejs.enable = true;
      pnpm = {
        enable = true;
        package = lib.defaultTo pkgs.pnpm-bin.latest (pkgs.pnpm-bin.fromProject ./.);
      };
      lsp.enable = true;
    };
    typescript = {
      enable = true;
      lsp.enable = true;
    };
  };

  # pi-task-governor's tests drive real jj repositories and direnv environments
  packages = with pkgs; [
    direnv
    jujutsu
  ];

  scripts.pnpm-up.exec = let
    major = lib.versions.major config.languages.javascript.pnpm.package.version;
  in "pnpm pkg set packageManager=pnpm@${pkgs.pnpm-bin.majors.${major}.version}";

  enterTest = ''
    node --version
    pnpm --version
    jj --version
    direnv --version
  '';
}
