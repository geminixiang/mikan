---
title: Firecracker setup guide
description: Configure a Firecracker microVM for mikan's experimental Firecracker sandbox mode.
---

Warning: mikan's Firecracker support is still very early alpha. This guide is kept for experiments and validation; it is not yet the recommended sandbox path for normal development or production. Unless you are explicitly testing Firecracker, prefer `image:<image>`.

## Prerequisites

- Linux host with KVM support
- root/sudo access for network setup
- VM uses SSH key-based authentication

## Installation steps

### 1. Install the Firecracker binary

```bash
# Download and install Firecracker
mkdir -p $HOME/firecracker
cp release-v1.15.0-x86_64/firecracker-v1.15.0-x86_64 /usr/local/bin/firecracker
chmod +x /usr/local/bin/firecracker

# Verify
firecracker --version
```

### 2. Download kernel and rootfs

Follow the official Firecracker getting-started guide to download the kernel and rootfs:

```bash
cd $HOME/firecracker

# Get CI version from the latest release
ARCH="x86_64"
release_url="https://github.com/firecracker-microvm/firecracker/releases"
CI_VERSION=$(basename $(curl -fsSLI -o /dev/null -w %{url_effective} ${release_url}/latest))

# Download kernel
latest_kernel_key=$(curl "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${CI_VERSION}/$ARCH/vmlinux-&list-type=2" 2>/dev/null | \
    grep -oP "(?<=<Key>)(firecracker-ci/${CI_VERSION}/$ARCH/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" | sort -V | tail -1)
wget "https://s3.amazonaws.com/spec.ccfc.min/${latest_kernel_key}" -O vmlinux

# Download rootfs squashfs
latest_ubuntu_key=$(curl "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${CI_VERSION}/$ARCH/ubuntu-&list-type=2" 2>/dev/null | \
    grep -oP "(?<=<Key>)(firecracker-ci/${CI_VERSION}/$ARCH/ubuntu-[0-9]+\.[0-9]+\.squashfs)(?=</Key>)" | sort -V | tail -1)
wget "https://s3.amazonaws.com/spec.ccfc.min/${latest_ubuntu_key}" -O ubuntu-24.04.squashfs.upstream
```

### 3. Unpack and configure rootfs

```bash
cd $HOME/firecracker

# Unpack squashfs
unsquashfs ubuntu-24.04.squashfs.upstream

# Generate SSH key for VM access
ssh-keygen -f id_rsa -N "" -q

# Add public key to rootfs
mkdir -p squashfs-root/root/.ssh
cp id_rsa.pub squashfs-root/root/.ssh/authorized_keys

# Create ext4 filesystem
truncate -s 1G ubuntu-24.04.ext4
mkfs.ext4 -d squashfs-root -F ubuntu-24.04.ext4
```

### 4. Start Firecracker (requires two terminals)

#### Terminal 1: configure networking and start Firecracker

```bash
cd $HOME/firecracker

# Configure tap interface
sudo ip link del tap0 2>/dev/null || true
sudo ip tuntap add dev tap0 mode tap
sudo ip addr add 172.16.0.1/30 dev tap0
sudo ip link set dev tap0 up

# Enable IP forwarding
sudo sh -c "echo 1 > /proc/sys/net/ipv4/ip_forward"
sudo iptables -P FORWARD ACCEPT

# Start firecracker
sudo firecracker --api-sock /tmp/firecracker.socket --enable-pci
```

#### Terminal 2: configure VM

```bash
cd $HOME/firecracker
API_SOCKET="/tmp/firecracker.socket"

# Configure log file
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"log_path": "./firecracker.log", "level": "Debug", "show_level": true, "show_log_origin": true}' \
    "http://localhost/logger"

# Configure boot source
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"kernel_image_path": "./vmlinux", "boot_args": "console=ttyS0 reboot=k panic=1"}' \
    "http://localhost/boot-source"

# Configure rootfs
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"drive_id": "rootfs", "path_on_host": "./ubuntu-24.04.ext4", "is_root_device": true, "is_read_only": false}' \
    "http://localhost/drives/rootfs"

# Configure network interface (MAC determines IP: 06:00:AC:10:00:02 → 172.16.0.2)
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"iface_id": "net1", "guest_mac": "06:00:AC:10:00:02", "host_dev_name": "tap0"}' \
    "http://localhost/network-interfaces/net1"

# Start VM
sleep 0.5
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"action_type": "InstanceStart"}' \
    "http://localhost/actions"

# Wait for boot
sleep 3s

# Configure guest network and DNS
ssh -i ./id_rsa -o StrictHostKeyChecking=no root@172.16.0.2 \
    "ip route add default via 172.16.0.1 && echo 'nameserver 8.8.8.8' > /etc/resolv.conf"
```

### 5. Verify SSH access

```bash
# Test SSH connection
ssh -i ./id_rsa root@172.16.0.2 "echo 'Connected!' && uname -a"

# Expected output: Connected!
# Linux localhost 6.1.0... x86_64 GNU/Linux
```

## Use with Mikan

Firecracker VMs are yours, not mikan's, so mikan cannot enforce a per-conversation workspace
projection in one. It therefore refuses to run under the default `isolated` door policy. Choose a
trusted policy explicitly before starting — in `<state-dir>/settings.json`:

```json
{
  "sandbox": {
    "workspace": { "doorPolicy": "trusted", "layout": "shared-support" }
  }
}
```

After the VM starts:

```bash
# Run mikan with Firecracker sandbox
mikan --sandbox=firecracker:172.16.0.2:$HOME/workspace $HOME/workspace

# Use a custom SSH user
mikan --sandbox=firecracker:172.16.0.2:$HOME/workspace:ubuntu $HOME/workspace

# Use a custom SSH port
mikan --sandbox=firecracker:172.16.0.2:$HOME/workspace:root:22 $HOME/workspace
```

## Shutdown

Inside the VM:

```bash
reboot
```

This shuts down Firecracker normally. To force exit:

```bash
sudo killall firecracker
```

## Troubleshooting

### KVM access denied

```bash
# Check KVM module
lsmod | grep kvm

# Grant access
sudo setfacl -m u:${USER}:rw /dev/kvm
# Or add user to kvm group
sudo usermod -aG kvm ${USER}
```

### VM does not boot

- Check logs: `tail -f $HOME/firecracker/firecracker.log`
- Confirm kernel and rootfs paths are correct
- Confirm the tap interface is enabled: `ip link show tap0`

### SSH connection refused

- Wait a little longer for VM boot (try 10 seconds)
- Check network: `ping 172.16.0.2`
- Confirm SSH is running in the VM: `ssh -v -i ./id_rsa root@172.16.0.2`

## File summary

| File                | Description                       |
| ------------------- | --------------------------------- |
| `vmlinux`           | Linux kernel used by Firecracker  |
| `ubuntu-24.04.ext4` | Root filesystem (1GB)             |
| `id_rsa`            | SSH private key (keep it secret!) |
| `id_rsa.pub`        | SSH public key                    |
| `firecracker.log`   | Firecracker execution log         |
