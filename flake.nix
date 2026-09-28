{
  description = "FlySight Viewer: web page + BLE debugging tools";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            (pkgs.python3.withPackages (p: [
              p.bleak
              p.numpy
              p.matplotlib
            ]))
            pkgs.bluez # bluetoothctl, btmon
          ];
        };
      });
    };
}
