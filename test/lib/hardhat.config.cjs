module.exports = {
  networks: {
    hardhat: {
      chainId: Number(process.env.LOCAL_CHAIN_ID),
      accounts: [],
      hardfork: 'cancun',
    },
  },
};
