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
      # FIXME: patchelf 0.19.2 leaves node's .dynamic in a read-only segment, so node segfaults on Linux; drop this once nixpkgs ships patchelf 0.19.3 (NixOS/nixpkgs#577387)
      package = pkgs.node-bin.lts.overrideAttrs (old: {
        nativeBuildInputs =
          lib.optional pkgs.stdenv.hostPlatform.isLinux (pkgs.patchelf.overrideAttrs {
            version = "0.15.2";
            src = pkgs.fetchurl {
              url = "https://github.com/NixOS/patchelf/releases/download/0.15.2/patchelf-0.15.2.tar.bz2";
              hash = "sha256-F3RfVkFZyOIo/EEtplogSLhGxLa0Igt3y/IkFuAvLXw=";
            };
          })
          ++ old.nativeBuildInputs;
      });
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
